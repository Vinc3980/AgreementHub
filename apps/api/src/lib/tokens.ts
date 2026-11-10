/**
 * Session tokens: opaque 256-bit random tokens. Only the SHA-256 hash is
 * persisted, so database reads never yield a usable credential. Presented
 * via httpOnly cookie (browser) or Authorization: Bearer (API clients).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Invitation tokens: same scheme as sessions (raw value shown once to invitee). */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newRequestId(): string {
  return randomUUID();
}
