/**
 * /parties routes: list, invite, accept invitation.
 * The raw invitation token is returned exactly once at invite time.
 */
import type { FastifyInstance } from 'fastify';
import { acceptInvitationRequestSchema, invitePartyRequestSchema } from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { acceptInvitation, inviteParty, listAgreementParties } from '../services/parties.js';
import type { ActorContext } from '../services/context.js';
import { getAgreement } from '../services/agreements.js';
import { avatarUrlsForUsers } from '../services/avatars.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerPartyRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/agreements/:id/parties', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const parties = await listAgreementParties(db, ctx, id);
    const avatarUrls = await avatarUrlsForUsers(
      db,
      parties.map((p) => p.user_id),
    );
    return {
      parties: parties.map((p) => ({
        id: p.id,
        email: p.email,
        displayName: p.display_name,
        avatarUrl: (p.user_id ? avatarUrls.get(p.user_id) : null) ?? null,
        role: p.role,
        signingOrder: p.signing_order,
        status: p.status,
        linked: p.user_id !== null,
        addedAt: p.added_at.toISOString(),
        signedAt: p.signed_at?.toISOString() ?? null,
      })),
    };
  });

  app.post('/agreements/:id/parties', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = invitePartyRequestSchema.parse(request.body);
    const { party, rawToken, expiresAt } = await inviteParty(db, ctx, id, input);
    return reply.status(201).send({
      party: {
        id: party.id,
        email: party.email,
        displayName: party.display_name,
        avatarUrl: null,
        role: party.role,
        signingOrder: party.signing_order,
        status: party.status,
      },
      // Delivered once; only the hash is stored server-side.
      invitation: { token: rawToken, expiresAt: expiresAt.toISOString() },
    });
  });

  app.post('/parties/accept-invitation', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const input = acceptInvitationRequestSchema.parse(request.body);
    const result = await acceptInvitation(db, ctx, input.token);
    // Refresh-friendly: return where to go next.
    const detail = await getAgreement(db, ctx, result.agreementId);
    return {
      agreementId: result.agreementId,
      publicId: result.publicId,
      status: detail.agreement.status,
    };
  });
}
