/**
 * Notification service (SPEC §16).
 *
 * - In-app notification rows are inserted inside the caller's transaction.
 * - Per-user preferences suppress non-essential categories; security and
 *   action-required notifications are never suppressible.
 * - Email fan-out is queued in the same transaction (`email_outbox`) and
 *   delivered by the worker after commit, never inline SMTP.
 */
import { many, one, type Queryable } from '../db.js';
import { getNotificationPreferences, type NotificationPreferences } from './accounts.js';
import { enqueueEmail } from './outbox.js';

export type NotificationType =
  | 'PARTY_INVITED'
  | 'APPROVAL_REQUESTED'
  | 'SIGNATURE_REQUESTED'
  | 'DOCUMENT_SIGNED'
  | 'AGREEMENT_FINALIZED'
  | 'COMMENT_ADDED'
  | 'COMMENT_STATUS_CHANGED'
  | 'CHANGE_SUGGESTED'
  | 'CHANGE_DECIDED'
  | 'AMENDMENT_STARTED'
  | 'STATUS_CHANGED'
  | 'INVITATION_ACCEPTED'
  | 'REMINDER_PENDING_SIGNATURE'
  | 'REMINDER_EXPIRY_SOON'
  | 'REMINDER_EXPIRED'
  | 'REMINDER_SIGNATURE_REQUESTED'
  | 'OBLIGATION_REMINDER'
  | 'OBLIGATION_OVERDUE';

export type NotificationCategory = keyof Pick<
  NotificationPreferences,
  'reminders' | 'comments' | 'activity'
>;

/**
 * Category mapping. `null` means the notification is essential (account
 * security or an action the recipient must take) and cannot be disabled.
 */
export function categoryForType(type: NotificationType): NotificationCategory | null {
  switch (type) {
    case 'REMINDER_PENDING_SIGNATURE':
    case 'REMINDER_EXPIRY_SOON':
    case 'REMINDER_EXPIRED':
    case 'REMINDER_SIGNATURE_REQUESTED':
    case 'OBLIGATION_REMINDER':
    case 'OBLIGATION_OVERDUE':
      return 'reminders';
    case 'COMMENT_ADDED':
    case 'COMMENT_STATUS_CHANGED':
      return 'comments';
    case 'DOCUMENT_SIGNED':
    case 'AGREEMENT_FINALIZED':
    case 'CHANGE_SUGGESTED':
    case 'CHANGE_DECIDED':
    case 'AMENDMENT_STARTED':
    case 'STATUS_CHANGED':
    case 'INVITATION_ACCEPTED':
      return 'activity';
    case 'PARTY_INVITED':
    case 'APPROVAL_REQUESTED':
    case 'SIGNATURE_REQUESTED':
      return null;
    default:
      return null;
  }
}

/** Notification types that also produce an email when delivery is enabled. */
function emailTemplateFor(
  type: NotificationType,
): 'SIGNATURE_REQUEST' | 'AGREEMENT_FINALIZED' | 'EXPIRY_REMINDER' | 'AGREEMENT_EXPIRED' | 'SIGNATURE_REMINDER' | 'OBLIGATION_REMINDER' | 'OBLIGATION_OVERDUE' | null {
  switch (type) {
    case 'SIGNATURE_REQUESTED':
      return 'SIGNATURE_REQUEST';
    case 'AGREEMENT_FINALIZED':
      return 'AGREEMENT_FINALIZED';
    case 'REMINDER_EXPIRY_SOON':
      return 'EXPIRY_REMINDER';
    case 'REMINDER_EXPIRED':
      return 'AGREEMENT_EXPIRED';
    case 'REMINDER_PENDING_SIGNATURE':
    case 'REMINDER_SIGNATURE_REQUESTED':
      return 'SIGNATURE_REMINDER';
    case 'OBLIGATION_REMINDER':
      return 'OBLIGATION_REMINDER';
    case 'OBLIGATION_OVERDUE':
      return 'OBLIGATION_OVERDUE';
    default:
      return null;
  }
}

export interface NotificationRow {
  id: string;
  user_id: string;
  org_id: string | null;
  agreement_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export async function notify(
  db: Queryable,
  input: {
    userId: string;
    type: NotificationType;
    orgId?: string | null;
    agreementId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
  },
): Promise<boolean> {
  const category = categoryForType(input.type);
  let recipient: { email: string; email_verified_at: Date | null; notification_preferences: Record<string, unknown> } | undefined;
  let prefs: NotificationPreferences | null = null;

  if (category) {
    recipient = await one(
      db,
      `SELECT email, email_verified_at, notification_preferences FROM users WHERE id = $1`,
      [input.userId],
    );
    if (!recipient) return false;
    prefs = await getNotificationPreferences(db, input.userId);
    if (!prefs[category]) return false;
    if ((input.type === 'OBLIGATION_REMINDER' || input.type === 'OBLIGATION_OVERDUE') && prefs.obligationReminders === false) return false;
  }

  const inserted = await one<{ id: string }>(
    db,
    `INSERT INTO notifications (user_id, org_id, agreement_id, type, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.userId,
      input.orgId ?? null,
      input.agreementId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
    ],
  );

  // Duplicate dedupe key: already delivered (do not re-email either).
  if (!inserted) return false;

  const template = emailTemplateFor(input.type);
  if (!template) return true;

  if (!recipient) {
    recipient = await one(
      db,
      `SELECT email, email_verified_at, notification_preferences FROM users WHERE id = $1`,
      [input.userId],
    );
  }
  if (!recipient || !recipient.email_verified_at) return true;

  prefs = prefs ?? (await getNotificationPreferences(db, input.userId));
  // Action-required notifications (category === null) always email a verified
  // address; the email channel switch only governs optional categories.
  if (category && !prefs.email) return true;

  const payload = input.payload ?? {};
  await enqueueEmail(db, {
    to: recipient.email,
    template,
    payload: {
      agreementTitle: payload.title ?? 'Agreement',
      publicId: payload.publicId ?? '',
      message: payload.message ?? null,
      expiresAt: payload.expiresAt ?? null,
      daysLeft: payload.daysLeft ?? 0,
    },
    dedupeKey: `notify-email:${input.dedupeKey ?? inserted.id}`,
  });
  return true;
}

/** Notify every linked party user on an agreement (except optionally one). */
export async function notifyParties(
  db: Queryable,
  agreementId: string,
  orgId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
  excludeUserId?: string,
): Promise<void> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT DISTINCT user_id FROM agreement_parties
     WHERE agreement_id = $1 AND user_id IS NOT NULL
       AND ($2::uuid IS NULL OR user_id <> $2::uuid)`,
    [agreementId, excludeUserId ?? null],
  );
  for (const row of rows) {
    await notify(db, {
      userId: row.user_id,
      type,
      orgId,
      agreementId,
      payload,
    });
  }
}
