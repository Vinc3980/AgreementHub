/**
 * Profile picture routes.
 *
 * - POST /users/me/avatar   multipart upload, 2 MB max
 * - DELETE /users/me/avatar
 * - GET /users/:id/avatar   self or a user who shares an agreement with them
 *
 * Upload validation is content-based (magic bytes), never filename or MIME
 * header. Responses expose only `avatarUrl`; storage keys stay server-side.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import type { ActorContext } from '../services/context.js';
import { getProfile, publicProfile } from '../services/accounts.js';
import { listUserOrgs } from '../services/identity.js';
import {
  AVATAR_MAX_BYTES,
  INVALID_AVATAR_MESSAGE,
  clearAvatar,
  readAvatarForViewer,
  setAvatar,
} from '../services/avatars.js';

const uuidSchema = z.string().uuid();

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerUserRoutes(app: FastifyInstance): void {
  const { ahDb: db, ahConfig: config } = app;

  app.post('/users/me/avatar', { preHandler: authenticate }, async (request) => {
    const actor = actorOf(request);

    let bytes: Buffer;
    try {
      const file = await request.file();
      if (!file) {
        throw AppError.badRequest('INVALID_AVATAR', INVALID_AVATAR_MESSAGE);
      }
      bytes = await file.toBuffer();
    } catch (err) {
      if (err instanceof AppError) throw err;
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
        throw new AppError(413, 'FILE_TOO_LARGE', INVALID_AVATAR_MESSAGE);
      }
      throw new AppError(400, 'INVALID_AVATAR', INVALID_AVATAR_MESSAGE);
    }

    // Defense in depth: the multipart limit and this check agree.
    if (bytes.length > AVATAR_MAX_BYTES) {
      throw new AppError(413, 'FILE_TOO_LARGE', INVALID_AVATAR_MESSAGE);
    }

    await setAvatar(db, config, actor.userId, bytes);
    const user = await getProfile(db, actor.userId);
    if (!user) throw AppError.unauthorized();
    return {
      user: publicProfile(user),
      organizations: await listUserOrgs(db, actor.userId),
    };
  });

  app.delete('/users/me/avatar', { preHandler: authenticate }, async (request) => {
    const actor = actorOf(request);
    await clearAvatar(db, config, actor.userId);
    const user = await getProfile(db, actor.userId);
    if (!user) throw AppError.unauthorized();
    return {
      user: publicProfile(user),
      organizations: await listUserOrgs(db, actor.userId),
    };
  });

  app.get('/users/:id/avatar', { preHandler: authenticate }, async (request, reply) => {
    const actor = actorOf(request);
    const parsed = uuidSchema.safeParse((request.params as { id: string }).id);
    // Malformed ids are indistinguishable from invisible users.
    if (!parsed.success) throw AppError.notFound('Avatar not found.');

    const { bytes, etag } = await readAvatarForViewer(
      db,
      config,
      actor.userId,
      parsed.data,
    );

    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('ETag', etag);
    reply.header('Content-Type', 'image/webp');
    reply.header('Content-Length', String(bytes.length));
    reply.header('X-Content-Type-Options', 'nosniff');

    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some((v) => v.trim() === etag)) {
      return reply.status(304).send();
    }
    return reply.send(bytes);
  });
}
