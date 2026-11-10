/**
 * Accounts service: profile (onboarding), password reset, session listing.
 *
 * Security notes:
 * - Reset tokens are opaque 256-bit values; only their SHA-256 hash is stored.
 * - Reset requests always succeed from the caller's perspective (no account
 *   enumeration), the caller-side response is identical for known/unknown emails.
 * - Password reset revokes every session for the user.
 */
import { AppError } from '@agreementhub/domain';
import {
  isValidCountryCode,
  isValidGhRegion,
  normalizePhoneToE164,
} from '@agreementhub/domain/location';
import type { Db, Queryable } from '../db.js';
import { exec, many, one, withTransaction } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateSessionToken, hashToken } from '../lib/tokens.js';
import { avatarUrl } from './avatars.js';

export const USER_TYPES = [
  'INDIVIDUAL',
  'FREELANCER',
  'SMALL_BUSINESS',
  'PROFESSIONAL',
  'ORGANIZATION',
] as const;

export interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  created_at: Date;
  email_verified_at: Date | null;
  phone: string | null;
  /** Legacy free-text country (kept for compatibility; not written by application code). */
  country: string | null;
  country_code: string | null;
  region: string | null;
  organization_name: string | null;
  user_type: string | null;
  onboarding_completed_at: Date | null;
  is_platform_admin: boolean;
  notification_preferences: Record<string, unknown>;
  avatar_key: string | null;
  avatar_updated_at: Date | null;
}

/** Public profile projection, never exposes hashes or internal ids. */
export function publicProfile(row: ProfileRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    /** E.164 when stored (e.g. +233241234567). UI formats for display. */
    phone: row.phone,
    /** ISO 3166-1 alpha-2 code (preferred). */
    countryCode: row.country_code,
    /** Legacy field retained for compatibility; mirrors country_code when present. */
    country: row.country_code ?? row.country,
    region: row.region,
    organizationName: row.organization_name,
    userType: row.user_type,
    onboardingCompletedAt: row.onboarding_completed_at?.toISOString() ?? null,
    isPlatformAdmin: row.is_platform_admin,
    notificationPreferences: mergedPreferences(row.notification_preferences),
    avatarUrl: row.avatar_key ? avatarUrl(row.id, row.avatar_updated_at) : null,
  };
}

const PROFILE_COLUMNS = `id, email, display_name, status, created_at, email_verified_at,
                         phone, country, country_code, region, organization_name, user_type, onboarding_completed_at,
                         is_platform_admin, notification_preferences, avatar_key, avatar_updated_at`;

export async function getProfile(db: Queryable, userId: string): Promise<ProfileRow | undefined> {
  return one<ProfileRow>(db, `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [userId]);
}

export interface UpdateProfileInput {
  displayName?: string;
  phone?: string;
  countryCode?: string;
  region?: string;
  /** Legacy free-text country, accepted for compatibility and ignored. */
  country?: string;
  organizationName?: string;
  userType?: string;
  completeOnboarding?: boolean;
}

export async function updateProfile(
  db: Db,
  userId: string,
  input: UpdateProfileInput,
): Promise<ProfileRow> {
  // Column whitelist keyed by input field, never interpolate user data.
  const assignments: string[] = [];
  const values: unknown[] = [userId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  // Determine effective country for phone normalization/region validation.
  const existing = await getProfile(db, userId);
  if (!existing) throw AppError.notFound('User not found.');
  const nextCountryCode =
    input.countryCode !== undefined
      ? input.countryCode === ''
        ? null
        : String(input.countryCode).trim().toUpperCase()
      : existing.country_code;

  if (input.displayName !== undefined) set('display_name', input.displayName);

  if (input.phone !== undefined) {
    if (input.phone === '') {
      set('phone', null);
    } else {
      const normalized = normalizePhoneToE164(input.phone, nextCountryCode ?? 'GH');
      if (!normalized) {
        throw AppError.badRequest(
          'INVALID_PHONE',
          'Enter a valid phone number (e.g. 024 123 4567 or +233 24 123 4567).',
          { field: 'phone' },
        );
      }
      set('phone', normalized);
    }
  }

  if (input.countryCode !== undefined) {
    if (input.countryCode === '') {
      set('country_code', null);
    } else {
      const cc = String(input.countryCode).trim().toUpperCase();
      if (!isValidCountryCode(cc)) {
        throw AppError.badRequest('INVALID_COUNTRY', 'Select a valid country.', { field: 'countryCode' });
      }
      set('country_code', cc);
    }
  }

  if (input.region !== undefined) {
    if (input.region === '') {
      set('region', null);
    } else {
      const region = String(input.region).trim();
      const cc = nextCountryCode;
      if (cc === 'GH' && !isValidGhRegion(region)) {
        throw AppError.badRequest('INVALID_REGION', 'Select a valid region of Ghana.', { field: 'region' });
      }
      set('region', region);
    }
  }

  // Legacy `country` is intentionally not written.
  if (input.organizationName !== undefined) {
    set('organization_name', input.organizationName === '' ? null : input.organizationName);
  }
  if (input.userType !== undefined) set('user_type', input.userType);
  if (input.completeOnboarding) set('onboarding_completed_at', new Date());

  if (assignments.length === 0) return existing;

  const row = await one<ProfileRow>(
    db,
    `UPDATE users SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING ${PROFILE_COLUMNS}`,
    values,
  );
  if (!row) throw AppError.notFound('User not found.');
  return row;
}

/* ------------------------------------------------------------------ */
/* Notification preferences                                            */
/* ------------------------------------------------------------------ */

export interface NotificationPreferences {
  reminders: boolean;
  comments: boolean;
  activity: boolean;
  email: boolean;
  /** Post-signature obligation reminders (falls back to `reminders` behavior when absent). */
  obligationReminders: boolean;
  /** Reminder offsets in days relative to due date: positive=before, 0=on due date, negative=after. */
  obligationReminderDays: number[];
}

export const DEFAULT_OBLIGATION_REMINDER_DAYS = [7, 3, 1, 0, -1] as const;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  reminders: true,
  comments: true,
  activity: true,
  email: true,
  obligationReminders: true,
  obligationReminderDays: [...DEFAULT_OBLIGATION_REMINDER_DAYS],
};

function sanitizeObligationReminderDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_OBLIGATION_REMINDER_DAYS];
  const allowed = new Set([-30, -14, -7, -3, -1, 0, 1, 3, 7, 14, 30]);
  const days = raw
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isInteger(v) && allowed.has(v));
  const unique = [...new Set(days)].sort((a, b) => b - a);
  return unique.length > 0 ? unique : [...DEFAULT_OBLIGATION_REMINDER_DAYS];
}

function mergedPreferences(raw: Record<string, unknown> | null | undefined): NotificationPreferences {
  const out = { ...DEFAULT_NOTIFICATION_PREFERENCES, obligationReminderDays: [...DEFAULT_NOTIFICATION_PREFERENCES.obligationReminderDays] };
  if (!raw) return out;
  for (const key of ['reminders', 'comments', 'activity', 'email', 'obligationReminders'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  if (raw.obligationReminders === undefined && typeof raw.reminders === 'boolean') {
    out.obligationReminders = raw.reminders;
  }
  if ('obligationReminderDays' in raw) out.obligationReminderDays = sanitizeObligationReminderDays(raw.obligationReminderDays);
  return out;
}

export async function getNotificationPreferences(
  db: Queryable,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await one<{ notification_preferences: Record<string, unknown> }>(
    db,
    `SELECT notification_preferences FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) throw AppError.notFound('User not found.');
  return mergedPreferences(row.notification_preferences);
}

export async function updateNotificationPreferences(
  db: Db,
  userId: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const row = await one<{ notification_preferences: Record<string, unknown> }>(
    db,
    `UPDATE users
        SET notification_preferences = notification_preferences || $2::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING notification_preferences`,
    [userId, JSON.stringify(patch)],
  );
  if (!row) throw AppError.notFound('User not found.');
  return mergedPreferences(row.notification_preferences);
}

/* ------------------------------------------------------------------ */
/* Password reset                                                      */
/* ------------------------------------------------------------------ */

export const RESET_TOKEN_TTL_MINUTES = 30;

export interface ResetTokenResult {
  /** Raw token, returned to the caller only outside production. */
  token: string;
  expiresAt: Date;
}

/**
 * Create a reset token for the account matching `email`.
 * Returns null for unknown emails so the route can answer uniformly
 * (no enumeration); production responses never echo the token anyway.
 */
export async function createPasswordReset(
  db: Db,
  email: string,
  ip: string | null,
): Promise<ResetTokenResult | null> {
  const user = await one<{ id: string }>(
    db,
    `SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND status = 'ACTIVE'`,
    [email],
  );
  if (!user) return null;

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
  await exec(
    db,
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, $4)`,
    [user.id, hashToken(token), expiresAt, ip],
  );
  return { token, expiresAt };
}

/** Validate + consume a reset token and set the new password. */
export async function resetPassword(db: Db, token: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(db, async (tx) => {
    const row = await one<{ id: string; user_id: string }>(
      tx,
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    if (!row) {
      throw AppError.badRequest(
        'INVALID_RESET_TOKEN',
        'This reset link is invalid, already used, or expired. Request a new one.',
      );
    }
    await exec(tx, `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    await exec(
      tx,
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [passwordHash, row.user_id],
    );
    // A password change invalidates every existing session.
    await exec(tx, `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
      row.user_id,
    ]);
  });
}

/** Verify the current password, then set the new one and revoke other sessions. */
export async function changePassword(
  db: Db,
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId: string | null,
): Promise<void> {
  const row = await one<{ password_hash: string }>(
    db,
    `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!row) throw AppError.notFound('User not found.');

  const ok = await verifyPassword(row.password_hash, currentPassword);
  if (!ok) {
    throw AppError.badRequest('CURRENT_PASSWORD_INVALID', 'Your current password is incorrect.');
  }

  const passwordHash = await hashPassword(newPassword);
  await withTransaction(db, async (tx) => {
    await exec(tx, `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [
      passwordHash,
      userId,
    ]);
    if (keepSessionId) {
      await exec(
        tx,
        `UPDATE auth_sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
        [userId, keepSessionId],
      );
    } else {
      await exec(tx, `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1`, [userId]);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Session management                                                  */
/* ------------------------------------------------------------------ */

export interface SessionSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export async function listSessions(
  db: Db,
  userId: string,
  currentSessionId: string | null,
): Promise<SessionSummary[]> {
  const rows = await many<{ id: string; issued_at: Date; expires_at: Date; ip: string | null; user_agent: string | null }>(
    db,
    `SELECT id, issued_at, expires_at, ip, user_agent
     FROM auth_sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY issued_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.issued_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    ip: r.ip,
    userAgent: r.user_agent,
    current: r.id === currentSessionId,
  }));
}

/** Revoke one of the caller's own sessions (404 when not theirs). */
export async function revokeSessionById(
  db: Db,
  userId: string,
  sessionId: string,
): Promise<void> {
  const row = await one<{ id: string }>(
    db,
    `UPDATE auth_sessions SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, userId],
  );
  if (!row) throw AppError.notFound('Session not found.');
}
