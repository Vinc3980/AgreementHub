/**
 * /approvals routes: request approvals, record approval decisions.
 */
import type { FastifyInstance } from 'fastify';
import { recordApprovalRequestSchema, requestApprovalRequestSchema } from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { recordApproval, requestApproval } from '../services/approvals.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerApprovalRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.post('/approvals/request', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const input = requestApprovalRequestSchema.parse(request.body);
    const result = await requestApproval(db, ctx, {
      agreementId: input.agreementId,
      versionId: input.versionId,
      partyIds: input.partyIds,
      note: input.note,
    });
    return result;
  });

  app.post('/approvals', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const input = recordApprovalRequestSchema.parse(request.body);
    const result = await recordApproval(db, ctx, {
      agreementId: input.agreementId,
      decision: input.decision,
      comment: input.comment,
    });
    return {
      approval: {
        id: result.approval.id,
        decision: result.approval.decision,
        decidedAt: result.approval.decided_at.toISOString(),
      },
      policySatisfied: result.policySatisfied,
      versionStatus: result.newStatus,
    };
  });
}
