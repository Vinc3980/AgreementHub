/**
 * Identity service: register, login, sessions.
 * - Passwords hashed with Argon2id (never stored/returned in plain text).
 * - Sessions: opaque token, only SHA-256 hash persisted, TTL-bound, revocable.
 * - Registration creates the user's home organization (OWNER membership).
 */
import { AppError } from '@agreementhub/domain';
import type { Db } from '../db.js';
import { exec, one, withTransaction, type Queryable } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateSessionToken, hashToken } from '../lib/tokens.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  created_at: Date;
}

export interface SessionUser {
  user: UserRow;
  sessionId: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  organizationName?: string;
}

/** Public projection, the only shape ever returned by the API. */
export function toPublicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

function slugify(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${suffix.slice(0, 8)}`;
}

export async function register(
  db: Db,
  input: RegisterInput,
  sessionMeta: { ip?: string | null; userAgent?: string | null; ttlHours?: number } = {},
): Promise<{ user: UserRow; token: string; expiresAt: Date }> {
  const passwordHash = await hashPassword(input.password);

  return withTransaction(db, async (tx) => {
    const existing = await one<{ id: string }>(
      tx,
      `SELECT id FROM users WHERE lower(email) = lower($1)`,
      [input.email],
    );
    if (existing) {
      throw AppError.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
    }

    // Phase 1 fix: do NOT auto-verify email at registration.
    // A verification token is issued separately and must be consumed.
    const user = await one<UserRow>(
      tx,
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, status, created_at`,
      [input.email, passwordHash, input.displayName],
    );
    if (!user) throw AppError.internal('Failed to create user.');

    // Home organization (spec FR-1.3).
    const orgName = input.organizationName ?? `${input.displayName}'s Workspace`;
    const org = await one<{ id: string }>(
      tx,
      `INSERT INTO organizations (name, slug, owner_user_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [orgName, slugify(orgName, user.id), user.id],
    );
    if (!org) throw AppError.internal('Failed to create organization.');
    await exec(
      tx,
      `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
      [org.id, user.id],
    );

    const session = await createSession(tx, user.id, sessionMeta);
    return { user, ...session };
  });
}

export async function login(
  db: Db,
  input: { email: string; password: string },
  sessionMeta: { ip?: string | null; userAgent?: string | null; ttlHours?: number } = {},
): Promise<{ user: UserRow; token: string; expiresAt: Date }> {
  const row = await one<UserRow & { password_hash: string }>(
    db,
    `SELECT id, email, display_name, status, created_at, password_hash
     FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [input.email],
  );

  // Always run verification to keep response timing uniform for unknown emails.
  const ok = row
    ? await verifyPassword(row.password_hash, input.password)
    : await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
        input.password,
      );

  if (!row || !ok) {
    throw AppError.unauthorized('Invalid email or password.');
  }
  if (row.status !== 'ACTIVE') {
    throw AppError.forbidden('This account is not active.');
  }

  const session = await createSession(db, row.id, sessionMeta);
  const { password_hash: _ph, ...user } = row;
  return { user: user as UserRow, ...session };
}

async function createSession(
  db: Queryable,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null; ttlHours?: number },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const ttlHours = meta.ttlHours ?? 168;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  await exec(
    db,
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );
  return { token, expiresAt };
}

export interface ResolvedSession {
  user: UserRow;
  sessionId: string;
}

/** Resolve a raw session token → user, or null when invalid/expired/revoked. */
export async function resolveSession(db: Db, token: string): Promise<ResolvedSession | null> {
  const row = await one<{
    session_id: string;
    id: string;
    email: string;
    display_name: string;
    status: string;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    db,
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
            u.id, u.email, u.display_name, u.status, u.created_at
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  if (row.status !== 'ACTIVE') return null;

  const { session_id: sessionId, expires_at: _e, revoked_at: _r, ...user } = row;
  return { user: user as UserRow, sessionId };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await exec(db, `UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1`, [
    hashToken(token),
  ]);
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await exec(db, `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1`, [userId]);
}

export async function listUserOrgs(
  db: Db,
  userId: string,
): Promise<Array<{ id: string; name: string; slug: string; role: string }>> {
  const rows = await one<{ rows: Array<{ id: string; name: string; slug: string; role: string }> }>(
    db,
    `SELECT COALESCE(json_agg(json_build_object(
              'id', o.id, 'name', o.name, 'slug', o.slug, 'role', m.role)
             ORDER BY o.created_at), '[]'::json) AS rows
     FROM organizations o
     JOIN organization_members m ON m.org_id = o.id AND m.user_id = $1 AND m.status = 'ACTIVE'
     WHERE o.deleted_at IS NULL`,
    [userId],
  );
  return rows?.rows ?? [];
}
