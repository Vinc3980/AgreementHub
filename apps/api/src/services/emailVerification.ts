/**
 * Email verification service (Phase 1).
 *
 * Registration no longer auto-verifies. After registration:
 * 1. createEmailVerificationToken() is called → raw token returned once.
 * 2. Token is emailed to the user (via the email abstraction).
 * 3. verifyEmail() is called with the raw token → marks email_verified_at.
 *
 * Security properties:
 * - 32-byte cryptographically random token; SHA-256 hash stored only.
 * - 24-hour TTL; single-use (used_at set atomically).
 * - One active token per user (DB UNIQUE index on active tokens).
 * - Resend invalidates the previous pending token.
 * - Invitation acceptance requires email_verified_at to be set.
 */
import { AppError } from '@agreementhub/domain';
import type { Db, Queryable } from '../db.js';
import { exec, one, withTransaction } from '../db.js';
import { generateSessionToken, hashToken } from '../lib/tokens.js';
import { recordAudit } from './audit.js';

export const EMAIL_VERIFY_TTL_HOURS = 24;
/** Minimum seconds between verification emails to the same account. */
export const EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS = 60;

export interface VerificationTokenResult {
  /** Raw token, must be delivered to the user via email, never stored. */
  rawToken: string;
  expiresAt: Date;
}

/**
 * Issue a new email verification token for `userId`.
 * Any existing un-used token for the user is revoked first (single active
 * token invariant; the DB unique index enforces this as a backstop).
 */
export async function createEmailVerificationToken(
  db: Db,
  userId: string,
  ip: string | null,
): Promise<VerificationTokenResult> {
  const rawToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_HOURS * 3600 * 1000);

  await withTransaction(db, async (tx) => {
    // Invalidate any existing pending token for this user.
    await exec(
      tx,
      `UPDATE email_verification_tokens
       SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );

    await exec(
      tx,
      `INSERT INTO email_verification_tokens
         (user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)`,
      [userId, hashToken(rawToken), expiresAt, ip],
    );
  });

  return { rawToken, expiresAt };
}

/**
 * Consume the raw token, set email_verified_at, return the user id.
 * Throws appropriate AppError on invalid / expired / already-used tokens.
 */
export async function verifyEmail(
  db: Db,
  rawToken: string,
): Promise<{ userId: string; email: string | null }> {
  return withTransaction(db, async (tx) => {
    const row = await one<{ id: string; user_id: string }>(
      tx,
      `SELECT id, user_id
       FROM email_verification_tokens
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > now()`,
      [hashToken(rawToken)],
    );
    if (!row) {
      throw AppError.badRequest(
        'INVALID_VERIFICATION_TOKEN',
        'This verification link is invalid, already used, or expired. Request a new one.',
      );
    }

    // Mark token used (single-use).
    await exec(
      tx,
      `UPDATE email_verification_tokens SET used_at = now() WHERE id = $1`,
      [row.id],
    );

    // Set email_verified_at only if not already set (idempotent for the user).
    await exec(
      tx,
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
       WHERE id = $1`,
      [row.user_id],
    );

    // Audit the verification against the user's home organization (org-scoped
    // chain). A user without an org has no scope; the verification still holds.
    const user = await one<{ email: string; org_id: string | null }>(
      tx,
      `SELECT u.email,
              (SELECT m.org_id FROM organization_members m
                WHERE m.user_id = u.id AND m.status = 'ACTIVE'
                ORDER BY (m.role = 'OWNER') DESC, m.joined_at LIMIT 1) AS org_id
       FROM users u WHERE u.id = $1`,
      [row.user_id],
    );
    if (user?.org_id) {
      await recordAudit(tx, {
        orgId: user.org_id,
        eventType: 'EMAIL_VERIFIED',
        actor: { type: 'USER', id: row.user_id, label: user.email },
        metadata: { method: 'TOKEN_LINK' },
        requestId: null,
      });
    }

    return { userId: row.user_id, email: user?.email ?? null };
  });
}

/** Seconds until a verification email may be resent (0 = ready). */
export async function resendCooldownRemaining(db: Queryable, userId: string): Promise<number> {
  const row = await one<{ seconds: number }>(
    db,
    `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
              created_at + interval '${EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS} seconds' - now()
            ))))::int AS seconds
       FROM email_verification_tokens
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  return row?.seconds ?? 0;
}

/**
 * Returns whether the given user's email is verified.
 * Used by guards that require verified email (e.g., invitation acceptance).
 */
export async function isEmailVerified(db: Queryable, userId: string): Promise<boolean> {
  const row = await one<{ verified: boolean }>(
    db,
    `SELECT (email_verified_at IS NOT NULL) AS verified FROM users WHERE id = $1`,
    [userId],
  );
  return row?.verified ?? false;
}
