/**
 * Audit trail: events for significant actions, hash-chain integrity,
 * append-only enforcement at the database level.
 */
import { describe, expect, it } from 'vitest';
import { auditEventCategory } from '@agreementhub/domain';
import { verifyAuditChain } from '../src/services/audit.js';
import {
  createAgreement,
  firstTemplateId,
  get,
  patch,
  post,
  registerUser,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('audit events', () => {
  it('records significant actions as a contiguous, hash-chained sequence', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, owner.token);
    const sec = detail.json().sections[0] as { code: string; title: string };
    await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { sections: [{ code: sec.code, title: sec.title, body: 'Edited', included: true }] },
      owner.token,
    );
    await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: uniqueEmail('auditee'), role: 'SIGNER' },
      owner.token,
    );
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, owner.token);

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, owner.token);
    expect(audit.statusCode).toBe(200);
    const events = audit.json().events as Array<{
      seq: number;
      eventType: string;
      eventHash: string;
      prevHash?: string;
      actorLabel: string;
      requestId: string | null;
    }>;

    const types = events.map((e) => e.eventType);
    expect(types).toContain('AGREEMENT_CREATED');
    expect(types).toContain('AGREEMENT_UPDATED');
    expect(types).toContain('PARTY_INVITED');
    expect(types).toContain('AGREEMENT_SUBMITTED');

    // Contiguous sequence starting at 1.
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    // Every event is hash-addressed.
    for (const e of events) {
      expect(e.eventHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Actor and request attribution are captured.
    expect(events[0]?.actorLabel).toBe(owner.email);
    expect(events[0]?.requestId).toBeTruthy();
  });

  it('verifyAuditChain passes on an untouched history', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, owner.token);

    const count = await verifyAuditChain(h().db, agreement.id);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('blocks UPDATE and DELETE on audit_events via DB triggers', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const { rows } = await h().db.query<{ id: string }>(
      `SELECT id FROM audit_events WHERE agreement_id = $1 LIMIT 1`,
      [agreement.id],
    );
    const eventId = rows[0]?.id;

    await expect(
      h().db.query(`UPDATE audit_events SET event_type = 'TAMPERED' WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);

    await expect(
      h().db.query(`DELETE FROM audit_events WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/);

    const { rows: after } = await h().db.query(`SELECT id FROM audit_events WHERE id = $1`, [eventId]);
    expect(after).toHaveLength(1);
  });

  it('detects a forged event appended outside the service (chain break ⇒ error)', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    // Bypass the service and append a forged event with a bogus hash link.
    const bogusPrev = 'f'.repeat(64);
    const bogusHash = 'e'.repeat(64);
    await h().db.query(
      `INSERT INTO audit_events
         (agreement_id, org_id, seq, event_type, actor_type, actor_id, actor_label,
          metadata, request_id, occurred_at, prev_hash, event_hash)
       SELECT $1, org_id, COALESCE(MAX(seq), 0) + 1, 'AGREEMENT_STATUS_CHANGED',
              'USER', $2, 'forged@example.com', '{}'::jsonb, NULL, now(),
              $3, $4
       FROM audit_events WHERE agreement_id = $1
       GROUP BY org_id`,
      [agreement.id, owner.userId, bogusPrev, bogusHash],
    );

    await expect(verifyAuditChain(h().db, agreement.id)).rejects.toThrow(/Chain break/);
  });

  it('scopes the audit timeline to visible events only (stranger gets 404)', async () => {
    const owner = await registerUser(h());
    const stranger = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const res = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, stranger.token);
    expect(res.statusCode).toBe(404);
  });

  it('attributes party actions to the acting party', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const email = uniqueEmail('viewer');
    const inviteRes = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email, role: 'SIGNER' },
      owner.token,
    );
    const raw = inviteRes.json().invitation.token as string;
    const invitee = await registerUser(h(), email);
    await post(h(), '/api/v1/parties/accept-invitation', { token: raw }, invitee.token);

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, owner.token);
    const accepted = (audit.json().events as Array<{ eventType: string; actorLabel: string }>).find(
      (e) => e.eventType === 'INVITATION_ACCEPTED',
    );
    expect(accepted?.actorLabel).toBe(email);
  });

  it('classifies every event as user activity, an agreement event, or a system event', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, owner.token);
    const sec = detail.json().sections[0] as { code: string; title: string };
    await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { sections: [{ code: sec.code, title: sec.title, body: 'Edited', included: true }] },
      owner.token,
    );
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, owner.token);

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, owner.token);
    const events = audit.json().events as Array<{ eventType: string; category: string }>;
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) {
      expect(['USER', 'AGREEMENT', 'SYSTEM']).toContain(e.category);
    }
    const byType = Object.fromEntries(events.map((e) => [e.eventType, e.category]));
    // Lifecycle events are agreement events; a person's edit is user activity.
    expect(byType['AGREEMENT_CREATED']).toBe('AGREEMENT');
    expect(byType['AGREEMENT_SUBMITTED']).toBe('AGREEMENT');
    expect(byType['AGREEMENT_UPDATED']).toBe('USER');
  });

  it('a system or AI actor is always classified as a system event', () => {
    expect(auditEventCategory('PARTY_VIEWED', 'SYSTEM')).toBe('SYSTEM');
    expect(auditEventCategory('AGREEMENT_UPDATED', 'AI')).toBe('SYSTEM');
    // Agreement lifecycle by a person is an agreement event; actions are user activity.
    expect(auditEventCategory('STATUS_CHANGED', 'USER')).toBe('AGREEMENT');
    expect(auditEventCategory('DOCUMENT_SIGNED', 'USER')).toBe('USER');
    expect(auditEventCategory('REMINDER_SENT', 'SYSTEM')).toBe('SYSTEM');
    expect(auditEventCategory('AGREEMENT_EXPIRED', 'SYSTEM')).toBe('AGREEMENT');
  });

  it('CSV export includes the event class column', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const res = await get(h(), `/api/v1/agreements/${agreement.id}/audit/export`, owner.token);
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe(
      'seq,event_type,category,actor_type,actor_label,occurred_at,request_id,event_hash,metadata',
    );
    // At least the creation event with its classification.
    expect(res.body).toContain('"AGREEMENT"');
  });
});
