/**
 * Background scheduler (audit Phase 6).
 *
 * Runs the three automated workflows the product needs:
 *   1. expiry transitions   ACTIVE → EXPIRING → EXPIRED
 *   2. expiry reminders     at the configured day ladder (default 30/7/1)
 *   3. signature reminders  T+3 days, then every 3 days, capped at 5
 * plus delivery of the email outbox and retention cleanup.
 *
 * Idempotency:
 *   - every reminder carries a dedupe key unique to (agreement, party, attempt),
 *   - status transitions skip rows already in the target state,
 *   - `pg_try_advisory_lock` prevents overlapping ticks across instances.
 *
 * All state changes and audit events commit in one transaction; no email is
 * sent while a transaction is open (the outbox worker handles that).
 */
import { AppError, assertTransition, type AgreementStatus } from '@agreementhub/domain';
import { expiryWarnDays, type Config } from '../config.js';
import { many, one, withTransaction, type Db } from '../db.js';
import { recordAudit } from './audit.js';
import { notify } from './notifications.js';
import { cleanupEmailOutbox, processEmailOutbox, type OutboxResult } from './outbox.js';
import { requireAccess, requireManage } from './access.js';
import { runObligationReminders } from './obligations.js';
import type { ActorContext } from './context.js';

const DAY_MS = 86_400_000;

export interface ExpirySweepResult {
  expiring: number;
  expired: number;
}

export interface ReminderSweepResult {
  reminders: number;
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / DAY_MS);
}

/** ACTIVE → EXPIRING (30 days out) and → EXPIRED (on the date). */
export async function runExpirySweep(db: Db, config: Config): Promise<ExpirySweepResult> {
  void config;
  return withTransaction(db, async (tx) => {
    const rows = await many<{
      id: string;
      public_id: string;
      title: string;
      status: AgreementStatus;
      expires_at: Date;
      org_id: string;
      current_version_id: string | null;
      final_version_id: string | null;
    }>(
      tx,
      `SELECT id, public_id, title, status, expires_at, org_id, current_version_id, final_version_id
         FROM agreements
        WHERE deleted_at IS NULL
          AND status IN ('ACTIVE', 'EXPIRING')
          AND expires_at IS NOT NULL
          AND expires_at <= now() + interval '30 days'
        ORDER BY expires_at
        FOR UPDATE SKIP LOCKED`,
      [],
    );

    const result: ExpirySweepResult = { expiring: 0, expired: 0 };
    for (const agreement of rows) {
      const next: AgreementStatus =
        agreement.expires_at.getTime() <= Date.now() ? 'EXPIRED' : 'EXPIRING';
      if (agreement.status === next) continue;

      // Domain guards run for SYSTEM (scheduler) rules too.
      assertTransition(agreement.status, next, 'SYSTEM');

      await tx.query(
        `UPDATE agreements
            SET status = $1,
                closed_reason = CASE WHEN $1 = 'EXPIRED' THEN 'EXPIRED' ELSE closed_reason END,
                closed_at = CASE WHEN $1 = 'EXPIRED' THEN now() ELSE closed_at END
          WHERE id = $2`,
        [next, agreement.id],
      );

      const versionRefs =
        agreement.final_version_id || agreement.current_version_id
          ? {
              versionId: agreement.final_version_id ?? agreement.current_version_id,
              finalVersionId: agreement.final_version_id,
              currentVersionId: agreement.current_version_id,
            }
          : {};

      await recordAudit(tx, {
        agreementId: agreement.id,
        orgId: agreement.org_id,
        eventType: 'STATUS_CHANGED',
        actor: { type: 'SYSTEM', label: 'scheduler' },
        metadata: {
          publicId: agreement.public_id,
          from: agreement.status,
          to: next,
          trigger: 'expiry date (scheduler)',
          expiresAt: agreement.expires_at.toISOString(),
          automatic: true,
          ...versionRefs,
        },
        requestId: null,
      });

      if (next === 'EXPIRED') {
        await recordAudit(tx, {
          agreementId: agreement.id,
          orgId: agreement.org_id,
          eventType: 'AGREEMENT_EXPIRED',
          actor: { type: 'SYSTEM', label: 'scheduler' },
          metadata: {
            publicId: agreement.public_id,
            from: agreement.status,
            to: next,
            trigger: 'expiry date (scheduler)',
            expiresAt: agreement.expires_at.toISOString(),
            automatic: true,
            ...versionRefs,
          },
          requestId: null,
        });
      }

      const payload = {
        publicId: agreement.public_id,
        title: agreement.title,
        from: agreement.status,
        to: next,
        expiresAt: agreement.expires_at.toISOString(),
        daysLeft: Math.max(0, daysUntil(agreement.expires_at)),
      };

      if (next === 'EXPIRED') {
        const parties = await many<{ user_id: string }>(
          tx,
          `SELECT DISTINCT user_id FROM agreement_parties
            WHERE agreement_id = $1 AND user_id IS NOT NULL`,
          [agreement.id],
        );
        for (const party of parties) {
          await notify(tx, {
            userId: party.user_id,
            type: 'REMINDER_EXPIRED',
            orgId: agreement.org_id,
            agreementId: agreement.id,
            payload,
            dedupeKey: `expired:${agreement.id}:${party.user_id}`,
          });
        }
        result.expired += 1;
      } else {
        const parties = await many<{ user_id: string }>(
          tx,
          `SELECT DISTINCT user_id FROM agreement_parties
            WHERE agreement_id = $1 AND user_id IS NOT NULL`,
          [agreement.id],
        );
        for (const party of parties) {
          await notify(tx, {
            userId: party.user_id,
            type: 'STATUS_CHANGED',
            orgId: agreement.org_id,
            agreementId: agreement.id,
            payload,
            dedupeKey: `expiring:${agreement.id}:${party.user_id}`,
          });
        }
        result.expiring += 1;
      }
    }
    return result;
  });
}

/**
 * Remind parties at the configured day ladder before expiry. At most one
 * reminder per agreement/user/warning window, regardless of tick frequency.
 */
export async function runExpiryReminders(db: Db, config: Config): Promise<ReminderSweepResult> {
  const warnDays = expiryWarnDays(config);
  if (warnDays.length === 0) return { reminders: 0 };
  const maxWarn = warnDays[0] ?? 0;

  const rows = await many<{
    id: string;
    public_id: string;
    title: string;
    org_id: string;
    expires_at: Date;
    days_left: number;
  }>(
    db,
    `SELECT id, public_id, title, org_id, expires_at,
            CEIL(EXTRACT(EPOCH FROM (expires_at - now())) / 86400)::int AS days_left
       FROM agreements
      WHERE deleted_at IS NULL
        AND status IN ('ACTIVE', 'EXPIRING')
        AND expires_at IS NOT NULL
        AND expires_at > now()
        AND expires_at <= now() + ($1 || ' days')::interval`,
    [String(maxWarn + 1)],
  );

  let reminders = 0;
  for (const agreement of rows) {
    // Computed in the database so rounding cannot disagree with the clock that
    // selected the row (a few milliseconds of drift must not skip a window).
    const daysLeft = agreement.days_left;
    if (!warnDays.includes(daysLeft)) continue;

    await withTransaction(db, async (tx) => {
      const parties = await many<{ user_id: string }>(
        tx,
        `SELECT DISTINCT user_id FROM agreement_parties
          WHERE agreement_id = $1 AND user_id IS NOT NULL`,
        [agreement.id],
      );
      let sent = 0;
      for (const party of parties) {
        const delivered = await notify(tx, {
          userId: party.user_id,
          type: 'REMINDER_EXPIRY_SOON',
          orgId: agreement.org_id,
          agreementId: agreement.id,
          payload: {
            publicId: agreement.public_id,
            title: agreement.title,
            expiresAt: agreement.expires_at.toISOString(),
            daysLeft,
          },
          dedupeKey: `expiry-remind:${agreement.id}:${daysLeft}:${party.user_id}`,
        });
        if (delivered) sent += 1;
      }
      if (sent > 0) {
        await recordAudit(tx, {
          agreementId: agreement.id,
          orgId: agreement.org_id,
          eventType: 'REMINDER_SENT',
          actor: { type: 'SYSTEM', label: 'scheduler' },
          metadata: {
            publicId: agreement.public_id,
            kind: 'EXPIRY',
            daysLeft,
            recipients: sent,
          },
          requestId: null,
        });
        reminders += 1;
      }
    });
  }
  return { reminders };
}

/**
 * Remind each unsigned required signer of the current version. The first
 * reminder is sent after the configured interval (default 3 days) and then at
 * the same interval, up to the configured cap (default 5).
 */
export async function runSignatureReminders(
  db: Db,
  config: Config,
): Promise<ReminderSweepResult> {
  const rows = await many<{
    agreement_id: string;
    public_id: string;
    title: string;
    org_id: string;
    version_id: string;
    user_id: string;
    party_id: string;
    reminders_sent: number;
    last_notice: Date;
  }>(
    db,
    `SELECT a.id AS agreement_id, a.public_id, a.title, a.org_id,
            a.current_version_id AS version_id,
            p.user_id, p.id AS party_id,
            COUNT(n.id) FILTER (WHERE n.type = 'REMINDER_PENDING_SIGNATURE')::int AS reminders_sent,
            MAX(n.created_at) AS last_notice
       FROM agreements a
       JOIN agreement_parties p
         ON p.agreement_id = a.id
        AND p.user_id IS NOT NULL
        AND p.role IN ('OWNER', 'SIGNER')
        AND p.status <> 'DECLINED'
       JOIN notifications n
         ON n.user_id = p.user_id
        AND n.agreement_id = a.id
        AND n.type IN ('SIGNATURE_REQUESTED', 'REMINDER_PENDING_SIGNATURE')
      WHERE a.deleted_at IS NULL
        AND a.status = 'AWAITING_SIGNATURES'
        AND a.current_version_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM signatures s
           WHERE s.agreement_id = a.id
             AND s.version_id = a.current_version_id
             AND s.party_id = p.id
        )
      GROUP BY a.id, a.public_id, a.title, a.org_id, a.current_version_id,
               p.user_id, p.id
      HAVING COUNT(n.id) FILTER (WHERE n.type = 'REMINDER_PENDING_SIGNATURE') < $1
         AND MAX(n.created_at) <= now() - ($2 || ' days')::interval`,
    [config.REMINDER_SIGNATURE_MAX, String(config.REMINDER_SIGNATURE_INTERVAL_DAYS)],
  );

  let reminders = 0;
  for (const row of rows) {
    await withTransaction(db, async (tx) => {
      const attempt = row.reminders_sent + 1;
      const delivered = await notify(tx, {
        userId: row.user_id,
        type: 'REMINDER_PENDING_SIGNATURE',
        orgId: row.org_id,
        agreementId: row.agreement_id,
        payload: {
          publicId: row.public_id,
          title: row.title,
          attempt,
          maxReminders: config.REMINDER_SIGNATURE_MAX,
        },
        dedupeKey: `sigremind:${row.version_id}:${row.party_id}:${attempt}`,
      });
      if (!delivered) return;

      await recordAudit(tx, {
        agreementId: row.agreement_id,
        orgId: row.org_id,
        eventType: 'REMINDER_SENT',
        actor: { type: 'SYSTEM', label: 'scheduler' },
        metadata: {
          publicId: row.public_id,
          kind: 'SIGNATURE',
          versionId: row.version_id,
          partyId: row.party_id,
          attempt,
        },
        requestId: null,
      });
      reminders += 1;
    });
  }
  return { reminders };
}

export interface SchedulerTickResult {
  skipped: boolean;
  expiry: ExpirySweepResult;
  expiryReminders: number;
  signatureReminders: number;
  obligationReminders: number;
  obligationsUpdated: number;
  outbox: OutboxResult;
}

/** One full scheduler pass, serialized across API instances. */
export async function runSchedulerTick(db: Db, config: Config): Promise<SchedulerTickResult> {
  const client = await db.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('agreementhub:scheduler')) AS locked`,
    );
    if (!lock.rows[0]?.locked) {
      return {
        skipped: true,
        expiry: { expiring: 0, expired: 0 },
        expiryReminders: 0,
        signatureReminders: 0,
        obligationReminders: 0,
        obligationsUpdated: 0,
        outbox: { claimed: 0, sent: 0, failed: 0 },
      };
    }
    try {
      const expiry = await runExpirySweep(db, config);
      const expiryReminders = await runExpiryReminders(db, config);
      const signatureReminders = await runSignatureReminders(db, config);
      const obligations = await runObligationReminders(db);
      const outbox = await processEmailOutbox(db, config);
      await cleanupEmailOutbox(db, config);
      return {
        skipped: false,
        expiry,
        expiryReminders: expiryReminders.reminders,
        signatureReminders: signatureReminders.reminders,
        obligationReminders: obligations.reminders,
        obligationsUpdated: obligations.updated,
        outbox,
      };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('agreementhub:scheduler'))`);
    }
  } finally {
    client.release();
  }
}

/**
 * Start the periodic timer. Returns a stop function. Interval 0 disables it.
 * The first tick runs shortly after boot so missed reminders catch up.
 */
export function startScheduler(
  db: Db,
  config: Config,
  onError: (err: unknown) => void,
): () => void {
  if (config.SCHEDULER_INTERVAL_MS <= 0) return () => {};

  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void runSchedulerTick(db, config)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  };

  const warmup = setTimeout(tick, 5_000);
  warmup.unref?.();
  const timer = setInterval(tick, config.SCHEDULER_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearTimeout(warmup);
    clearInterval(timer);
  };
}

/**
 * Manual reminder trigger (owner-facing endpoint). Throttled to at most one
 * reminder per signer per hour; the scheduler's 3-day cadence is unaffected.
 */
export async function sendSignatureReminder(
  db: Db,
  actor: ActorContext,
  agreementId: string,
  partyId?: string,
): Promise<{ sent: number; throttled: number; skipped: number }> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, actor.userId, actor.email, agreementId);
    requireManage(access);
    if (access.agreement.status !== 'AWAITING_SIGNATURES') {
      throw AppError.conflict(
        'NOT_AWAITING_SIGNATURES',
        'Reminders can only be sent while signatures are being collected.',
      );
    }
    const versionId = access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version.');

    const rows = await many<{ party_id: string; user_id: string; email: string }>(
      tx,
      `SELECT p.id AS party_id, p.user_id, p.email
         FROM agreement_parties p
        WHERE p.agreement_id = $1
          AND p.role IN ('OWNER', 'SIGNER')
          AND p.status <> 'DECLINED'
          AND p.user_id IS NOT NULL
          AND ($2::uuid IS NULL OR p.id = $2::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM signatures s
             WHERE s.agreement_id = p.agreement_id
               AND s.version_id = $3
               AND s.party_id = p.id
          )`,
      [agreementId, partyId ?? null, versionId],
    );

    if (rows.length === 0) {
      throw AppError.conflict(
        'NOTHING_TO_REMIND',
        'There are no unsigned signers matching that request.',
      );
    }

    let sent = 0;
    let throttled = 0;
    let skipped = 0;
    for (const row of rows) {
      const recent = await one<{ seconds: number }>(
        tx,
        `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
                  created_at + interval '1 hour' - now()
                ))))::int AS seconds
           FROM notifications
          WHERE user_id = $1 AND agreement_id = $2
            AND type = 'REMINDER_PENDING_SIGNATURE'
          ORDER BY created_at DESC LIMIT 1`,
        [row.user_id, agreementId],
      );
      if ((recent?.seconds ?? 0) > 0) {
        throttled += 1;
        continue;
      }

      const count = await one<{ c: number }>(
        tx,
        `SELECT COUNT(*)::int AS c FROM notifications
          WHERE user_id = $1 AND agreement_id = $2
            AND type = 'REMINDER_PENDING_SIGNATURE'`,
        [row.user_id, agreementId],
      );
      const attempt = (count?.c ?? 0) + 1;
      if (attempt > 5) {
        skipped += 1;
        continue;
      }

      const delivered = await notify(tx, {
        userId: row.user_id,
        type: 'REMINDER_PENDING_SIGNATURE',
        orgId: access.agreement.org_id,
        agreementId,
        payload: {
          publicId: access.agreement.public_id,
          title: access.agreement.title,
          attempt,
          manual: true,
          requestedBy: actor.displayName,
        },
        dedupeKey: `sigremind:${versionId}:${row.party_id}:${attempt}`,
      });
      if (!delivered) {
        skipped += 1;
        continue;
      }

      await recordAudit(tx, {
        agreementId,
        orgId: access.agreement.org_id,
        eventType: 'REMINDER_SENT',
        actor: { type: 'USER', id: actor.userId, label: actor.email },
        metadata: {
          publicId: access.agreement.public_id,
          kind: 'SIGNATURE',
          versionId,
          partyId: row.party_id,
          attempt,
          manual: true,
        },
        requestId: actor.requestId,
      });
      sent += 1;
    }

    return { sent, throttled, skipped };
  });
}
