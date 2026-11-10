/**
 * /comments routes: list and add comments (review/negotiation).
 */
import type { FastifyInstance } from 'fastify';
import { addCommentRequestSchema, updateCommentRequestSchema } from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { addComment, listComments, setCommentStatus } from '../services/comments.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

function serializeComment(c: {
  id: string;
  agreement_id: string;
  version_id: string | null;
  section_code: string | null;
  parent_id: string | null;
  author_type: string;
  author_label: string;
  body: string;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
}) {
  return {
    id: c.id,
    agreementId: c.agreement_id,
    versionId: c.version_id,
    sectionCode: c.section_code,
    parentId: c.parent_id,
    authorType: c.author_type,
    authorLabel: c.author_label,
    body: c.body,
    status: c.status,
    createdAt: c.created_at.toISOString(),
    resolvedAt: c.resolved_at?.toISOString() ?? null,
  };
}

export function registerCommentRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/comments', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { agreementId } = request.query as { agreementId?: string };
    if (!agreementId) {
      throw AppError.badRequest('MISSING_PARAM', 'agreementId query parameter is required.');
    }
    const comments = await listComments(db, ctx, agreementId);
    return { comments: comments.map(serializeComment) };
  });

  app.post('/comments', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const input = addCommentRequestSchema.parse(request.body);
    const comment = await addComment(db, ctx, input);
    return reply.status(201).send({ comment: serializeComment(comment) });
  });

  app.patch('/comments/:id', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = updateCommentRequestSchema.parse(request.body);
    const comment = await setCommentStatus(db, ctx, id, input.status);
    return { comment: serializeComment(comment) };
  });
}
