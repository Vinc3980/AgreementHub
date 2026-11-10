/**
 * Transactional email outbox (Phase 6).
 *
 * Business code enqueues an email inside the same transaction as its state
 * change (`enqueueEmail`); the worker (`processEmailOutbox`) delivers it after
 * commit with retries and exponential backoff. This gives at-least-once
 * delivery without ever holding a database transaction open across SMTP.
 *
 * Idempotency: a non-null `dedupe_key` is unique across the outbox, so re-running
 * a job (or a retried request) never sends the same message twice.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` so multiple API instances can run the
 * worker concurrently; a lease (`next_attempt_at`) lets crashed claims recover.
 */
import { AppError } from '@agreementhub/domain';
import type { Config } from '../config.js';
import { many, type Db, type Queryable } from '../db.js';
import { renderEmailTemplate, sendEmail, type EmailTemplate } from './email.js';

export interface EnqueueEmailInput {
  to: string;
  template: EmailTemplate;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}

/** Queue an email. Safe to call inside a transaction; never sends inline. */
export async function enqueueEmail(db: Queryable, input: EnqueueEmailInput): Promise<void> {
  const { rows } = await db.query(
    `INSERT INTO email_outbox (to_email, template, payload, dedupe_key)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.to,
      input.template,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
    ],
  );
  if (rows.length === 0 && input.dedupeKey) {
    // Duplicate key, already queued. Not an error (idempotent).
    return;
  }
}

interface OutboxRow {
  id: string;
  to_email: string;
  template: EmailTemplate;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxResult {
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * Deliver due outbox rows. Returns counts for logging/metrics.
 * `limit` bounds work per tick so a large backlog never blocks the scheduler.
 */
export async function processEmailOutbox(
  db: Db,
  config: Config,
  limit = 25,
): Promise<OutboxResult> {
  if (limit <= 0) return { claimed: 0, sent: 0, failed: 0 };

  // Claim due PENDING rows plus SENDING rows whose lease expired (crash recovery).
  const claimed = await many<OutboxRow>(
    db,
    `WITH due AS (
       SELECT id FROM email_outbox
       WHERE (status = 'PENDING' AND next_attempt_at <= now())
          OR (status = 'SENDING' AND next_attempt_at <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE email_outbox o
        SET status = 'SENDING',
            next_attempt_at = now() + interval '5 minutes'
       FROM due
      WHERE o.id = due.id
      RETURNING o.id, o.to_email, o.template, o.payload, o.attempts`,
    [limit],
  );

  let sent = 0;
  let failed = 0;

  for (const row of claimed) {
    const message = renderEmailTemplate(config, row.template, row.to_email, row.payload);
    const ok = await sendEmail(config, message);
    if (ok) {
      await db.query(
        `UPDATE email_outbox
            SET status = 'SENT', sent_at = now(), attempts = attempts + 1,
                last_error = NULL
          WHERE id = $1`,
        [row.id],
      );
      sent += 1;
    } else {
      const nextAttempt = row.attempts + 1;
      const exhausted = nextAttempt >= config.EMAIL_RETRY_MAX;
      // Exponential backoff: 1, 2, 4, 8… minutes, capped at 60.
      const backoffMinutes = Math.min(2 ** Math.min(nextAttempt, 6), 60);
      await db.query(
        `UPDATE email_outbox
            SET status = $2, attempts = attempts + 1,
                last_error = 'delivery failed',
                next_attempt_at = now() + ($3 || ' minutes')::interval
          WHERE id = $1`,
        [row.id, exhausted ? 'FAILED' : 'PENDING', String(backoffMinutes)],
      );
      failed += 1;
    }
  }

  return { claimed: claimed.length, sent, failed };
}

/** Delete delivered rows past the retention window (keeps the outbox bounded). */
export async function cleanupEmailOutbox(db: Db, config: Config): Promise<number> {
  if (config.EMAIL_RETENTION_DAYS <= 0) return 0;
  const res = await db.query(
    `DELETE FROM email_outbox
      WHERE status = 'SENT'
        AND sent_at IS NOT NULL
        AND sent_at < now() - ($1 || ' days')::interval`,
    [String(config.EMAIL_RETENTION_DAYS)],
  );
  return res.rowCount ?? 0;
}

/** Read the latest queued email for an address (tests / admin diagnostics). */
export async function findLatestOutboxEmail(
  db: Queryable,
  to: string,
  template?: EmailTemplate,
): Promise<{ id: string; template: string; payload: Record<string, unknown>; status: string } | null> {
  const rows = await many<{ id: string; template: string; payload: Record<string, unknown>; status: string }>(
    db,
    `SELECT id, template, payload, status FROM email_outbox
      WHERE lower(to_email) = lower($1)
        AND ($2::text IS NULL OR template = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [to, template ?? null],
  );
  return rows[0] ?? null;
}

/** Guard for future callers: the outbox must not be used outside a DB. */
export function assertOutboxDb(db: Queryable | undefined): asserts db is Queryable {
  if (!db) throw AppError.internal('Email outbox requires a database connection.');
}
