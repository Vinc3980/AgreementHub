/**
 * Email OTP signing verification (Phase 3).
 *
 * A signer requests a six-digit code; the code is:
 *   - generated with crypto.randomInt (never Math.random),
 *   - stored only as a SHA-256 hash,
 *   - valid for 10 minutes, single-use, max 5 attempts,
 *   - bound to agreement + version + party (+ the party's email),
 *   - rate-limited to one request per minute per party/version.
 *
 * Only a successfully consumed code allows method EMAIL_OTP; the signature
 * record then carries identity_assurance = EMAIL_OTP_VERIFIED. Every other
 * method records AUTHENTICATED_SESSION, never an unearned "verified" claim.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { AppError, sha256Hex } from '@agreementhub/domain';
import type { Db, Queryable } from '../db.js';
import { exec, one, withTransaction } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import { requireAccess, requireSigner } from './access.js';
import { recordAudit } from './audit.js';
import { enqueueEmail } from './outbox.js';
import { getVersion } from './versions.js';

export const SIGNATURE_OTP_TTL_MINUTES = 10;
export const SIGNATURE_OTP_MAX_ATTEMPTS = 5;
export const SIGNATURE_OTP_RESEND_COOLDOWN_SECONDS = 60;

function hashOtp(code: string): string {
  return sha256Hex(`sign-otp:${code}`);
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function maskEmail(email: string): string {
  const [local = '', domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export interface OtpRequestResult {
  expiresAt: Date;
  sentTo: string;
}

/** Issue (or re-issue) a signing code for the caller's current version. */
export async function requestSignatureOtp(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<OtpRequestResult> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    const party = requireSigner(access);

    if (access.agreement.status !== 'AWAITING_SIGNATURES') {
      throw AppError.conflict(
        'NOT_AWAITING_SIGNATURES',
        'Signing codes are only available while signatures are being collected.',
      );
    }
    const versionId = access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version.');
    const version = await getVersion(tx, versionId);
    if (!version || version.status !== 'APPROVED') {
      throw AppError.conflict('VERSION_NOT_APPROVED', 'The current version is not approved for signing.');
    }

    const alreadySigned = await one<{ id: string }>(
      tx,
      `SELECT id FROM signatures WHERE version_id = $1 AND party_id = $2`,
      [versionId, party.id],
    );
    if (alreadySigned) {
      throw AppError.conflict('ALREADY_SIGNED', 'You have already signed this version.');
    }

    // Per-party/version cooldown (on top of the global credential rate limit).
    const recent = await one<{ seconds: number }>(
      tx,
      `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
                created_at + interval '${SIGNATURE_OTP_RESEND_COOLDOWN_SECONDS} seconds' - now()
              ))))::int AS seconds
         FROM signature_otps
        WHERE version_id = $1 AND party_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [versionId, party.id],
    );
    if ((recent?.seconds ?? 0) > 0) {
      throw AppError.tooMany(
        `Please wait ${recent?.seconds} second(s) before requesting another signing code.`,
      );
    }

    // Only one active code per party/version.
    await exec(
      tx,
      `UPDATE signature_otps SET used_at = now()
        WHERE version_id = $1 AND party_id = $2 AND used_at IS NULL`,
      [versionId, party.id],
    );

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(Date.now() + SIGNATURE_OTP_TTL_MINUTES * 60 * 1000);
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO signature_otps
         (agreement_id, version_id, party_id, signer_email, otp_hash, expires_at, requested_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        agreementId,
        versionId,
        party.id,
        party.email,
        hashOtp(code),
        expiresAt,
        ctx.ip ?? null,
      ],
    );
    if (!row) throw AppError.internal('Failed to create the signing code.');

    await enqueueEmail(tx, {
      to: party.email,
      template: 'SIGNATURE_OTP',
      payload: {
        code,
        agreementTitle: access.agreement.title,
        publicId: access.agreement.public_id,
        expiresMinutes: SIGNATURE_OTP_TTL_MINUTES,
      },
      dedupeKey: `otp-email:${row.id}`,
    });

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'SIGNATURE_OTP_REQUESTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        versionId,
        partyId: party.id,
        method: 'EMAIL_OTP',
        expiresAt: expiresAt.toISOString(),
        // Never log the code itself.
      },
      requestId: ctx.requestId,
    });

    return { expiresAt, sentTo: maskEmail(party.email) };
  });
}

/**
 * Validate + consume a signing code. Must be called inside the signature
 * transaction so the code is used exactly once with the signature it authorised.
 */
export async function consumeSignatureOtp(
  tx: Queryable,
  input: {
    agreementId: string;
    versionId: string;
    partyId: string;
    signerEmail: string;
    code: string;
  },
): Promise<void> {
  const row = await one<{
    id: string;
    otp_hash: string;
    attempt_count: number;
    expires_at: Date;
    used_at: Date | null;
  }>(
    tx,
    `SELECT id, otp_hash, attempt_count, expires_at, used_at
       FROM signature_otps
      WHERE agreement_id = $1
        AND version_id = $2
        AND party_id = $3
        AND lower(signer_email) = lower($4)
        AND used_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [input.agreementId, input.versionId, input.partyId, input.signerEmail],
  );

  if (!row || row.expires_at.getTime() <= Date.now()) {
    throw AppError.badRequest(
      'OTP_INVALID',
      'The signing code is invalid or expired. Request a new code.',
    );
  }

  const attempts = row.attempt_count + 1;
  if (attempts > SIGNATURE_OTP_MAX_ATTEMPTS) {
    await exec(tx, `UPDATE signature_otps SET used_at = now() WHERE id = $1`, [row.id]);
    throw AppError.tooMany('Too many incorrect signing codes. Request a new code.');
  }
  await exec(tx, `UPDATE signature_otps SET attempt_count = $2 WHERE id = $1`, [row.id, attempts]);

  if (!safeEqualHex(hashOtp(input.code), row.otp_hash)) {
    throw AppError.badRequest('OTP_INVALID', 'Incorrect signing code.');
  }

  await exec(tx, `UPDATE signature_otps SET used_at = now() WHERE id = $1`, [row.id]);
}
