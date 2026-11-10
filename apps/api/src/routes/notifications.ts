/**
 * /notifications routes: list, mark read, mark all read, unread count.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { exec, many, one } from '../db.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerNotificationRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/notifications', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const query = request.query as { limit?: string; unread?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const onlyUnread = query.unread === 'true';

    const rows = await many(
      db,
      `SELECT id, type, agreement_id, payload, read_at, created_at
       FROM notifications
       WHERE user_id = $1
         AND ($2::boolean = false OR read_at IS NULL)
       ORDER BY created_at DESC
       LIMIT $3`,
      [ctx.userId, onlyUnread, limit],
    );

    const counts = await one<{ total: number; unread: number }>(
      db,
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
       FROM notifications WHERE user_id = $1`,
      [ctx.userId],
    );

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        agreementId: r.agreement_id,
        payload: r.payload,
        readAt: r.read_at instanceof Date ? r.read_at.toISOString() : r.read_at,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
      counts: { total: counts?.total ?? 0, unread: counts?.unread ?? 0 },
    };
  });

  app.post('/notifications/:id/read', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const row = await one<{ id: string }>(
      db,
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, ctx.userId],
    );
    if (!row) throw AppError.notFound('Notification not found.');
    return { id: row.id, read: true };
  });

  app.post('/notifications/read-all', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const result = await exec(
      db,
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [ctx.userId],
    );
    return { updated: result.rowCount ?? 0 };
  });
}
