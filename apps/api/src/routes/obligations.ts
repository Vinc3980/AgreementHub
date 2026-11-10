/**
 * /obligations routes: post-signature obligation tracking and reminders.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import type { ActorContext } from '../services/context.js';
import {
  cancelObligation,
  completeObligation,
  createObligation,
  listObligations,
  listObligationsOverview,
  reopenObligation,
  updateObligation,
} from '../services/obligations.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

const createSchema = z.object({
  versionId: z.string().uuid().optional().nullable(),
  responsiblePartyId: z.string().uuid().optional().nullable(),
  responsibleLabel: z.string().max(200).optional().nullable(),
  title: z.string().min(2).max(200),
  description: z.string().max(4000).optional().nullable(),
  dueAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
  notes: z.string().max(4000).optional().nullable(),
});

const updateSchema = z.object({
  versionId: z.string().uuid().optional().nullable(),
  responsiblePartyId: z.string().uuid().optional().nullable(),
  responsibleLabel: z.string().max(200).optional().nullable(),
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(4000).optional().nullable(),
  dueAt: z.string().optional(),
  notes: z.string().max(4000).optional().nullable(),
});

export function registerObligationRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/obligations', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const q = request.query as { agreementId?: string; status?: string; assigned?: string; dueFrom?: string; dueTo?: string; limit?: string };
    const validStatuses = new Set(['UPCOMING', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'CANCELLED']);
    const validAssigned = new Set(['me', 'others', 'all']);
    const status = q.status && validStatuses.has(q.status) ? (q.status as any) : undefined;
    const assigned = q.assigned && validAssigned.has(q.assigned) ? (q.assigned as any) : undefined;
    const agreementId = q.agreementId && /^[0-9a-f-]{36}$/i.test(q.agreementId) ? q.agreementId : undefined;
    const data = await listObligationsOverview(db, ctx, {
      agreementId,
      status,
      assigned,
      dueFrom: q.dueFrom,
      dueTo: q.dueTo,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return data;
  });

  app.get('/agreements/:id/obligations', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const obligations = await listObligations(db, ctx, id);
    return { obligations };
  });

  app.post('/agreements/:id/obligations', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = createSchema.parse(request.body);
    const obligation = await createObligation(db, ctx, { agreementId: id, ...input });
    return reply.status(201).send({ obligation });
  });

  app.patch('/obligations/:id', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = updateSchema.parse(request.body);
    const obligation = await updateObligation(db, ctx, id, input);
    return { obligation };
  });

  app.post('/obligations/:id/complete', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { notes?: string | null };
    const obligation = await completeObligation(db, ctx, id, body.notes ?? null);
    return { obligation };
  });

  app.post('/obligations/:id/cancel', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { notes?: string | null };
    const obligation = await cancelObligation(db, ctx, id, body.notes ?? null);
    return { obligation };
  });

  app.post('/obligations/:id/reopen', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const obligation = await reopenObligation(db, ctx, id);
    return { obligation };
  });
}
