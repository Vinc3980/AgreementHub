/**
 * Scheduler, reminders and outbox (audit Phase 6).
 *
 * Expiry transitions, expiry reminders and signature reminders are idempotent;
 * emails are enqueued transactionally and delivered by a separate worker.
 */
import { describe, expect, it } from 'vitest';
import {
  enqueueEmail,
  findLatestOutboxEmail,
  processEmailOutbox,
} from '../src/services/outbox.js';
import {
  runExpiryReminders,
  runExpirySweep,
  runSignatureReminders,
} from '../src/services/scheduler.js';
import { getSentEmails } from '../src/services/email.js';
import {
  createAgreement,
  firstTemplateId,
  latestEmailFor,
  post,
  registerUser,
  setupAwaitingSignatures,
  useTestApp,
} from './helpers.js';

const h = useTestApp({
  EXPIRY_WARN_DAYS: '3',
  REMINDER_SIGNATURE_INTERVAL_DAYS: 3,
  REMINDER_SIGNATURE_MAX: 3,
});

async function activeAgreement() {
  const setup = await setupAwaitingSignatures(h());
  await post(
    h(),
    '/api/v1/signatures',
    { agreementId: setup.agreementId, consent: true },
    setup.owner.token,
  );
  await post(
    h(),
    '/api/v1/signatures',
    { agreementId: setup.agreementId, consent: true },
    setup.counterparty.token,
  );
  const fin = await post(
    h(),
    `/api/v1/agreements/${setup.agreementId}/finalize`,
    {},
    setup.owner.token,
  );
  expect(fin.statusCode).toBe(200);
  return setup;
}

async function notificationCounts(agreementId: string, type: string) {
  const { rows } = await h().db.query<{ user_id: string; count: number }>(
    `SELECT user_id, COUNT(*)::int AS count FROM notifications
      WHERE agreement_id = $1 AND type = $2 GROUP BY user_id`,
    [agreementId, type],
  );
  return rows;
}

describe('expiry sweep', () => {
  it('moves ACTIVE → EXPIRING → EXPIRED exactly once and notifies parties', async () => {
    const setup = await activeAgreement();
    const config = h().app.ahConfig;

    await h().db.query(
      `UPDATE agreements SET expires_at = now() + interval '10 days' WHERE id = $1`,
      [setup.agreementId],
    );
    const first = await runExpirySweep(h().db, config);
    expect(first).toEqual({ expiring: 1, expired: 0 });

    const status1 = await h().db.query<{ status: string }>(
      `SELECT status FROM agreements WHERE id = $1`,
      [setup.agreementId],
    );
    expect(status1.rows[0]!.status).toBe('EXPIRING');
    expect(await notificationCounts(setup.agreementId, 'STATUS_CHANGED')).toHaveLength(2);

    // Repeated ticks do not duplicate anything.
    expect(await runExpirySweep(h().db, config)).toEqual({ expiring: 0, expired: 0 });
    expect(await notificationCounts(setup.agreementId, 'STATUS_CHANGED')).toHaveLength(2);

    await h().db.query(
      `UPDATE agreements SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [setup.agreementId],
    );
    expect(await runExpirySweep(h().db, config)).toEqual({ expiring: 0, expired: 1 });
    expect(await runExpirySweep(h().db, config)).toEqual({ expiring: 0, expired: 0 });

    const status2 = await h().db.query<{ status: string; closed_reason: string | null }>(
      `SELECT status, closed_reason FROM agreements WHERE id = $1`,
      [setup.agreementId],
    );
    expect(status2.rows[0]!.status).toBe('EXPIRED');
    expect(status2.rows[0]!.closed_reason).toBe('EXPIRED');

    expect(await notificationCounts(setup.agreementId, 'REMINDER_EXPIRED')).toHaveLength(2);
    const outbox = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM email_outbox
        WHERE template = 'AGREEMENT_EXPIRED' AND lower(to_email) IN (lower($1), lower($2))`,
      [setup.owner.email, setup.counterEmail],
    );
    expect(outbox.rows[0]!.count).toBe(2);

    const expiredAudit = await h().db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE agreement_id = $1 AND event_type = 'AGREEMENT_EXPIRED'`,
      [setup.agreementId],
    );
    expect(expiredAudit.rows).toHaveLength(1);
    expect(expiredAudit.rows[0]!.metadata.to).toBe('EXPIRED');
    expect(expiredAudit.rows[0]!.metadata.publicId).toBe(setup.publicId);
    expect(expiredAudit.rows[0]!.metadata.finalVersionId ?? expiredAudit.rows[0]!.metadata.versionId).toBeTruthy();
  });
});

describe('expiry reminders', () => {
  it('sends one reminder per party per warning window', async () => {
    const setup = await activeAgreement();
    const config = h().app.ahConfig;

    await h().db.query(
      `UPDATE agreements SET expires_at = now() + interval '3 days' WHERE id = $1`,
      [setup.agreementId],
    );
    expect(await runExpiryReminders(h().db, config)).toEqual({ reminders: 1 });
    expect(await runExpiryReminders(h().db, config)).toEqual({ reminders: 0 });

    expect(await notificationCounts(setup.agreementId, 'REMINDER_EXPIRY_SOON')).toHaveLength(2);
    const outbox = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM email_outbox
        WHERE template = 'EXPIRY_REMINDER' AND lower(to_email) IN (lower($1), lower($2))`,
      [setup.owner.email, setup.counterEmail],
    );
    expect(outbox.rows[0]!.count).toBe(2);
  });

  it('honours a user disabling reminders', async () => {
    const setup = await activeAgreement();
    const config = h().app.ahConfig;

    await h().db.query(
      `UPDATE users SET notification_preferences = '{"reminders":false}'::jsonb WHERE id = $1`,
      [setup.owner.userId],
    );
    await h().db.query(
      `UPDATE agreements SET expires_at = now() + interval '3 days' WHERE id = $1`,
      [setup.agreementId],
    );

    expect(await runExpiryReminders(h().db, config)).toEqual({ reminders: 1 });
    const counts = await notificationCounts(setup.agreementId, 'REMINDER_EXPIRY_SOON');
    expect(counts).toHaveLength(1);
    expect(counts[0]!.user_id).toBe(setup.counterparty.userId);
    expect(
      await latestEmailFor(h(), setup.owner.email, 'EXPIRY_REMINDER'),
    ).toBeNull();
  });
});

describe('signature reminders', () => {
  async function awaitingWithRequest() {
    const setup = await setupAwaitingSignatures(h());
    const request = await post(
      h(),
      '/api/v1/signatures/request',
      { agreementId: setup.agreementId },
      setup.owner.token,
    );
    expect(request.statusCode).toBe(200);
    return setup;
  }

  async function backdateRequests(agreementId: string, days = 4) {
    await h().db.query(
      `UPDATE notifications SET created_at = now() - ($2 || ' days')::interval
        WHERE agreement_id = $1 AND type = 'SIGNATURE_REQUESTED'`,
      [agreementId, String(days)],
    );
  }

  it('reminds unsigned signers after the interval and never duplicates', async () => {
    const setup = await awaitingWithRequest();
    const config = h().app.ahConfig;
    await backdateRequests(setup.agreementId);

    expect(await runSignatureReminders(h().db, config)).toEqual({ reminders: 2 });
    expect(await runSignatureReminders(h().db, config)).toEqual({ reminders: 0 });
    expect(
      await notificationCounts(setup.agreementId, 'REMINDER_PENDING_SIGNATURE'),
    ).toHaveLength(2);

    const outbox = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM email_outbox
        WHERE template = 'SIGNATURE_REMINDER'`,
    );
    expect(outbox.rows[0]!.count).toBe(2);

    // Only unsigned signers are reminded; the signer who signed drops out.
    await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true },
      setup.owner.token,
    );
    await h().db.query(
      `UPDATE notifications SET created_at = now() - interval '4 days'
        WHERE agreement_id = $1 AND type = 'REMINDER_PENDING_SIGNATURE'`,
      [setup.agreementId],
    );
    expect(await runSignatureReminders(h().db, config)).toEqual({ reminders: 1 });
  });

  it('skips signers who disabled reminders', async () => {
    const setup = await awaitingWithRequest();
    const config = h().app.ahConfig;
    await h().db.query(
      `UPDATE users SET notification_preferences = '{"reminders":false}'::jsonb WHERE id = $1`,
      [setup.counterparty.userId],
    );
    await backdateRequests(setup.agreementId);

    expect(await runSignatureReminders(h().db, config)).toEqual({ reminders: 1 });
    const counts = await notificationCounts(setup.agreementId, 'REMINDER_PENDING_SIGNATURE');
    expect(counts).toHaveLength(1);
    expect(counts[0]!.user_id).toBe(setup.owner.userId);
  });

  it('lets an owner send a manual reminder, throttled per signer', async () => {
    const setup = await awaitingWithRequest();

    const first = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/remind`,
      {},
      setup.owner.token,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ sent: 2, throttled: 0, skipped: 0 });

    const second = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/remind`,
      {},
      setup.owner.token,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ sent: 0, throttled: 2, skipped: 0 });

    const audit = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_events
        WHERE agreement_id = $1 AND event_type = 'REMINDER_SENT'
          AND metadata->>'manual' = 'true'`,
      [setup.agreementId],
    );
    expect(audit.rows[0]!.count).toBe(2);

    const outsider = await registerUser(h());
    const forbidden = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/remind`,
      {},
      outsider.token,
    );
    expect(forbidden.statusCode).toBe(404);
  });

  it('refuses manual reminders outside AWAITING_SIGNATURES', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/remind`,
      {},
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_AWAITING_SIGNATURES');
  });
});

describe('email outbox', () => {
  it('is idempotent per dedupe key and delivers exactly once', async () => {
    const config = h().app.ahConfig;
    const input = {
      to: 'outbox@example.com',
      template: 'GENERIC' as const,
      payload: { subject: 'Hello', text: 'Body' },
      dedupeKey: 'outbox-test:1',
    };
    await enqueueEmail(h().db, input);
    await enqueueEmail(h().db, input);

    const queued = await findLatestOutboxEmail(h().db, input.to, 'GENERIC');
    expect(queued).not.toBeNull();
    expect(queued!.status).toBe('PENDING');

    const { rows } = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM email_outbox WHERE dedupe_key = $1`,
      [input.dedupeKey],
    );
    expect(rows[0]!.count).toBe(1);

    const first = await processEmailOutbox(h().db, config);
    expect(first.sent).toBe(1);
    expect((await findLatestOutboxEmail(h().db, input.to, 'GENERIC'))!.status).toBe('SENT');

    const second = await processEmailOutbox(h().db, config);
    expect(second.claimed).toBe(0);
    expect(second.sent).toBe(0);
  });

  it('never sends inline while the business transaction is open', async () => {
    await enqueueEmail(h().db, {
      to: 'queued@example.com',
      template: 'GENERIC',
      payload: { subject: 'Queued', text: 'Not sent yet' },
    });
    // With the memory transport, delivery only happens in the worker.
    expect(getSentEmails().some((m) => m.to === 'queued@example.com')).toBe(false);
    expect((await findLatestOutboxEmail(h().db, 'queued@example.com'))!.status).toBe('PENDING');
  });
});
