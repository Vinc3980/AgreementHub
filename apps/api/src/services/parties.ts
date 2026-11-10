/**
 * Party & invitation services (SPEC §6/§FR-6).
 * Invitation tokens are random 256-bit values; only their SHA-256 hash is
 * stored. The raw token is returned exactly once (to be delivered out of band).
 */
import { AppError } from '@agreementhub/domain';
import { exec, many, one, withTransaction, type Db } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import { requireAccess, requireManage, listParties, type PartyRow } from './access.js';
import { recordAudit } from './audit.js';
import { generateInvitationToken, hashToken } from '../lib/tokens.js';
import { notify } from './notifications.js';
import { isEmailVerified } from './emailVerification.js';
import { enqueueEmail } from './outbox.js';

const INVITE_TTL_HOURS = 72;

export interface InvitePartyInput {
  email: string;
  displayName?: string;
  role: 'OWNER' | 'CONTRIBUTOR' | 'REVIEWER' | 'SIGNER' | 'OBSERVER';
  signingOrder: number;
}

export interface InvitationRow {
  id: string;
  agreement_id: string;
  email: string;
  role: string;
  token_hash: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_by: string;
  created_at: Date;
}

/**
 * Invite a counterparty. Creates the party (status INVITED) plus an
 * invitation with a hashed token. Returns the raw token ONCE.
 */
export async function inviteParty(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  input: InvitePartyInput,
): Promise<{ party: PartyRow; rawToken: string; expiresAt: Date }> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    requireManage(access);

    if (['DRAFT', 'REVIEW', 'NEGOTIATION'].includes(access.agreement.status) === false) {
      throw AppError.conflict(
        'INVITE_NOT_ALLOWED',
        `Parties cannot be invited while the agreement is ${access.agreement.status}.`,
      );
    }

    const existing = await one<{ id: string }>(
      tx,
      `SELECT id FROM agreement_parties WHERE agreement_id = $1 AND lower(email) = lower($2)`,
      [agreementId, input.email],
    );
    if (existing) {
      throw AppError.conflict('PARTY_EXISTS', 'That email is already a party on this agreement.');
    }

    const party = await one<PartyRow>(
      tx,
      `INSERT INTO agreement_parties
         (agreement_id, email, display_name, role, signing_order, status, added_by)
       VALUES ($1,$2,$3,$4,$5,'INVITED',$6)
       RETURNING *`,
      [agreementId, input.email, input.displayName ?? '', input.role, input.signingOrder, ctx.userId],
    );
    if (!party) throw AppError.internal('Failed to add party.');

    const rawToken = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);
    const invitation = await one<InvitationRow>(
      tx,
      `INSERT INTO invitations (agreement_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [agreementId, input.email, input.role, hashToken(rawToken), expiresAt, ctx.userId],
    );
    if (!invitation) throw AppError.internal('Failed to create invitation.');

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'PARTY_INVITED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        email: input.email,
        role: input.role,
        signingOrder: input.signingOrder,
        invitationId: invitation.id,
        expiresAt: expiresAt.toISOString(),
      },
      requestId: ctx.requestId,
    });

    // Deliver the invitation out of band (queued with the transaction; the
    // worker sends it after commit). The raw token exists only here + the
    // single queued email payload.
    await enqueueEmail(tx, {
      to: input.email,
      template: 'INVITATION',
      payload: {
        token: rawToken,
        agreementTitle: access.agreement.title,
        inviterName: ctx.displayName,
        role: input.role,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: `invite-email:${invitation.id}`,
    });

    // In-app notification if the invitee already has an account.
    const invitee = await one<{ id: string }>(
      tx,
      `SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [input.email],
    );
    if (invitee) {
      await notify(tx, {
        userId: invitee.id,
        type: 'PARTY_INVITED',
        orgId: access.agreement.org_id,
        agreementId,
        payload: {
          publicId: access.agreement.public_id,
          title: access.agreement.title,
          role: input.role,
        },
        dedupeKey: `invite:${agreementId}:${invitation.id}`,
      });
    }

    return { party, rawToken, expiresAt };
  });
}

/**
 * Accept an invitation. The caller must be authenticated with an email that
 * matches the invitation; the party is then linked to the user account.
 */
export async function acceptInvitation(
  db: Db,
  ctx: ActorContext,
  token: string,
): Promise<{ agreementId: string; publicId: string }> {
  return withTransaction(db, async (tx) => {
    const invitation = await one<InvitationRow>(
      tx,
      `SELECT * FROM invitations WHERE token_hash = $1`,
      [hashToken(token)],
    );
    if (!invitation || invitation.revoked_at) {
      throw AppError.notFound('Invitation not found or revoked.');
    }
    if (invitation.accepted_at) {
      throw AppError.conflict('INVITATION_USED', 'This invitation has already been accepted.');
    }
    if (invitation.expires_at.getTime() < Date.now()) {
      throw AppError.conflict('INVITATION_EXPIRED', 'This invitation has expired.');
    }
    if (invitation.email.toLowerCase() !== ctx.email.toLowerCase()) {
      // Do not reveal whose email it belongs to beyond the mismatch itself.
      throw AppError.forbidden('This invitation was issued to a different email address.');
    }
    // An invitation is an access grant to a specific, proven email identity.
    // An unverified account must not be able to claim it.
    if (!(await isEmailVerified(tx, ctx.userId))) {
      throw AppError.forbidden(
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before accepting this invitation.',
      );
    }

    const access = await requireAccess(tx, ctx.userId, ctx.email, invitation.agreement_id);
    const party = access.party;
    if (!party) {
      throw AppError.notFound('Party record not found for this invitation.');
    }

    await exec(
      tx,
      `UPDATE agreement_parties
       SET user_id = $1, display_name = COALESCE(NULLIF(display_name, ''), $2),
           status = CASE WHEN status = 'INVITED' THEN 'VIEWED' ELSE status END
       WHERE id = $3`,
      [ctx.userId, ctx.displayName, party.id],
    );
    await exec(tx, `UPDATE invitations SET accepted_at = now() WHERE id = $1`, [invitation.id]);

    await recordAudit(tx, {
      agreementId: invitation.agreement_id,
      orgId: access.agreement.org_id,
      eventType: 'INVITATION_ACCEPTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        invitationId: invitation.id,
        role: invitation.role,
      },
      requestId: ctx.requestId,
    });

    return { agreementId: invitation.agreement_id, publicId: access.agreement.public_id };
  });
}

export async function listAgreementParties(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<PartyRow[]> {
  const access = await requireAccess(db, ctx.userId, ctx.email, agreementId);
  return listParties(db, access.agreement.id);
}

/** Record a PARTY_VIEWED event when a party opens an agreement. */
export async function recordPartyView(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    if (!access.party || access.party.user_id !== ctx.userId) return; // org readers aren't "parties"
    if (access.party.status === 'INVITED') {
      await exec(tx, `UPDATE agreement_parties SET status = 'VIEWED' WHERE id = $1`, [
        access.party.id,
      ]);
    }
    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'PARTY_VIEWED',
      actor: auditActor(ctx),
      metadata: { publicId: access.agreement.public_id },
      requestId: ctx.requestId,
    });
  });
}
