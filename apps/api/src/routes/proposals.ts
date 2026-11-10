/**
 * /proposals routes: suggest, list, and decide (accept/reject) changes.
 *
 * Nothing here mutates the document except an explicit ACCEPT, which is
 * delegated to the same draft-update path used by PATCH /agreements/:id.
 */
import type { FastifyInstance } from 'fastify';
import {
  createProposalRequestSchema,
  decideProposalRequestSchema,
} from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import {
  createProposal,
  decideProposal,
  listProposals,
  type ProposalRow,
} from '../services/proposals.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

function serializeProposal(p: ProposalRow) {
  return {
    id: p.id,
    agreementId: p.agreement_id,
    versionId: p.version_id,
    kind: p.kind,
    targetCode: p.target_code,
    currentValue: p.current_value,
    proposedValue: p.proposed_value,
    note: p.note,
    status: p.status,
    proposedBy: p.proposed_by,
    proposedByLabel: p.proposed_by_label,
    decidedBy: p.decided_by,
    decidedByLabel: p.decided_by_label ?? null,
    decidedAt: p.decided_at?.toISOString() ?? null,
    decisionNote: p.decision_note,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

export function registerProposalRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/agreements/:id/proposals', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const proposals = await listProposals(db, ctx, id);
    return { proposals: proposals.map(serializeProposal) };
  });

  app.post('/proposals', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const input = createProposalRequestSchema.parse(request.body);
    const proposal = await createProposal(db, ctx, {
      agreementId: input.agreementId,
      versionId: input.versionId,
      kind: input.kind,
      targetCode: input.targetCode,
      proposedValue: input.proposedValue,
      note: input.note,
    });
    return reply.status(201).send({ proposal: serializeProposal(proposal) });
  });

  app.post('/proposals/:id/decide', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = decideProposalRequestSchema.parse(request.body);
    const result = await decideProposal(db, ctx, id, input.decision, input.note);
    return {
      proposal: serializeProposal(result.proposal),
      /** Set when an ACCEPT created a new version (always the case in negotiation). */
      versionCreated: result.versionCreated
        ? {
            id: result.versionCreated.id,
            versionNumber: result.versionCreated.version_number,
            status: result.versionCreated.status,
            changeSummary: result.versionCreated.change_summary,
            documentHash: result.versionCreated.document_hash,
            createdAt: result.versionCreated.created_at.toISOString(),
          }
        : null,
    };
  });
}
