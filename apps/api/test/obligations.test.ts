/**
 * Post-signature obligations (Phase F): CRUD, no auto-completion, overview,
 * version linkage/history signals, and authorization.
 */
import { describe, expect, it } from 'vitest';
import { createAgreement, firstTemplateId, get, post, patch, registerUser, setupAwaitingSignatures, useTestApp } from './helpers.js';

const h = useTestApp();

async function addObligation(token: string, agreementId: string, body: Record<string, unknown>) {
  return post(h(), `/api/v1/agreements/${agreementId}/obligations`, body, token);
}

describe('obligations', () => {
  it('creates and lists obligations for an agreement manager', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const created = await addObligation(user.token, agreement.id, {
      title: 'Deliver final report',
      description: 'Submit the final PDF report to the client.',
      dueAt,
      responsibleLabel: 'Service Provider',
      notes: 'Confirm receipt by email.',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { obligation: { id: string; status: string; agreementId: string; title: string; dueAt: string; completedAt: string | null; versionId: string | null } };
    expect(body.obligation.agreementId).toBe(agreement.id);
    expect(body.obligation.title).toBe('Deliver final report');
    expect(body.obligation.completedAt).toBeNull();
    expect(['UPCOMING', 'DUE_SOON']).toContain(body.obligation.status);

    const list = await get(h(), `/api/v1/agreements/${agreement.id}/obligations`, user.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().obligations).toHaveLength(1);
    expect(list.json().obligations[0].id).toBe(body.obligation.id);
  });

  it('never auto-completes an obligation when its due date passes', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const pastDue = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const created = await addObligation(user.token, agreement.id, {
      title: 'Overdue payment',
      dueAt: pastDue,
    });
    expect(created.statusCode).toBe(201);
    const obligation = created.json().obligation as { id: string; status: string; completedAt: string | null; cancelledAt: string | null };

    // Effective status reflects overdue timing, but completion is never inferred.
    expect(obligation.status).toBe('OVERDUE');
    expect(obligation.completedAt).toBeNull();
    expect(obligation.cancelledAt).toBeNull();

    const list = await get(h(), `/api/v1/agreements/${agreement.id}/obligations`, user.token);
    expect(list.json().obligations[0].status).toBe('OVERDUE');
    expect(list.json().obligations[0].completedAt).toBeNull();

    // Only an explicit action completes it.
    const completed = await post(h(), `/api/v1/obligations/${obligation.id}/complete`, { notes: 'Paid late.' }, user.token);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().obligation.status).toBe('COMPLETED');
    expect(completed.json().obligation.completedAt).toBeTruthy();
  });

  it('supports cancel and reopen (explicit actions only)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const dueAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const created = await addObligation(user.token, agreement.id, { title: 'Cancelable task', dueAt });
    const id = created.json().obligation.id as string;

    const cancelled = await post(h(), `/api/v1/obligations/${id}/cancel`, {}, user.token);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().obligation.status).toBe('CANCELLED');
    expect(cancelled.json().obligation.cancelledAt).toBeTruthy();

    const reopened = await post(h(), `/api/v1/obligations/${id}/reopen`, {}, user.token);
    expect(reopened.statusCode).toBe(200);
    expect(['UPCOMING', 'DUE_SOON', 'OVERDUE']).toContain(reopened.json().obligation.status);
    expect(reopened.json().obligation.cancelledAt).toBeNull();
  });

  it('validates responsible party belongs to the agreement', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await addObligation(user.token, agreement.id, {
      title: 'Bad party',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      responsiblePartyId: '00000000-0000-0000-0000-000000000099',
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces agreement visibility/authorization', async () => {
    const owner = await registerUser(h());
    const outsider = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    await addObligation(owner.token, agreement.id, {
      title: 'Private obligation',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    // Invisible agreement -> 404 (no IDOR leak), matching agreement access rules.
    const list = await get(h(), `/api/v1/agreements/${agreement.id}/obligations`, outsider.token);
    expect(list.statusCode).toBe(404);

    const overview = await get(h(), '/api/v1/obligations', outsider.token);
    expect(overview.statusCode).toBe(200);
    expect(overview.json().obligations).toHaveLength(0);
  });

  it('returns cross-agreement overview with filters and assignment summary', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    await addObligation(user.token, agreement.id, {
      title: 'Upcoming item',
      dueAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      responsibleLabel: 'Other party',
    });
    await addObligation(user.token, agreement.id, {
      title: 'Overdue item',
      dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      responsibleLabel: 'Other party',
    });

    const overview = await get(h(), '/api/v1/obligations?status=OVERDUE', user.token);
    expect(overview.statusCode).toBe(200);
    expect(overview.json().summary.overdue).toBeGreaterThanOrEqual(1);
    expect(overview.json().obligations.every((o: { status: string }) => o.status === 'OVERDUE')).toBe(true);
    expect(overview.json().obligations[0].agreementPublicId).toBe(agreement.publicId);

    const dueFiltered = await get(
      h(),
      `/api/v1/obligations?dueTo=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`,
      user.token,
    );
    expect(dueFiltered.statusCode).toBe(200);
    expect(dueFiltered.json().obligations.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves governing version linkage and can signal needsReview after version drift', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const current = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const versionId = current.json().currentVersion?.id as string | null;
    expect(versionId).toBeTruthy();

    const created = await addObligation(user.token, agreement.id, {
      title: 'Version-linked obligation',
      dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      versionId,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().obligation.versionId).toBe(versionId);

    // Simulate a newer governing version context without mutating obligation history:
    // add a later version and point agreement current/final context to it.
    const { rows } = await h().db.query<{ id: string; version_number: number }>(
      `INSERT INTO agreement_versions (agreement_id, version_number, content, document_hash, change_summary, status, created_by)
       SELECT $1, COALESCE(MAX(version_number), 0) + 1, '{"agreementPublicId":"x","title":"x","templateCode":"x","sections":[],"fields":[],"parties":[]}'::jsonb,
              'a'.repeat(64), 'test newer version', 'DRAFT', $2
         FROM agreement_versions WHERE agreement_id = $1
       RETURNING id, version_number`,
      [agreement.id, user.userId],
    );
    expect(rows[0]?.id).toBeTruthy();
    await h().db.query(
      `UPDATE agreements SET current_version_id = $1 WHERE id = $2`,
      [rows[0]!.id, agreement.id],
    );

    const overview = await get(h(), `/api/v1/obligations?agreementId=${agreement.id}`, user.token);
    expect(overview.statusCode).toBe(200);
    const item = overview.json().obligations.find((o: { title: string }) => o.title === 'Version-linked obligation');
    expect(item).toBeTruthy();
    expect(item.governingVersionNumber).toBe(1);
    expect(item.currentVersionNumber).toBeGreaterThanOrEqual(2);
    expect(item.needsReview).toBe(true);
    expect(item.status).not.toBe('COMPLETED');
  });
});

describe('amendment correctness (working copy restoration)', () => {
  it('restores working copy from the final snapshot when starting an amendment', async () => {
    const setup = await setupAwaitingSignatures(h());
    const { owner, agreementId } = setup;

    // Capture working copy state and finalize.
    const before = await get(h(), `/api/v1/agreements/${agreementId}`, owner.token);
    const beforeSections = before.json().sections as Array<{ code: string; body: string }>;
    const beforeFields = before.json().fields as Array<{ code: string; value: unknown }>;
    expect(beforeSections.length).toBeGreaterThan(0);

    await post(h(), '/api/v1/signatures', { agreementId, consent: true }, owner.token);
    await post(h(), '/api/v1/signatures', { agreementId, consent: true }, setup.counterparty.token);
    const fin = await post(h(), `/api/v1/agreements/${agreementId}/finalize`, {}, owner.token);
    expect(fin.statusCode).toBe(200);

    // Simulate stale working-copy drift (should not happen in normal flow, but the fix must protect correctness).
    const target = beforeSections[0]!;
    await h().db.query(
      `UPDATE agreement_sections SET body = $3 WHERE agreement_id = $1 AND code = $2`,
      [agreementId, target.code, 'STALE WORKING COPY'],
    );

    const amend = await post(h(), `/api/v1/agreements/${agreementId}/amendments`, {}, owner.token);
    expect(amend.statusCode).toBe(201);
    expect(amend.json().agreement.status).toBe('NEGOTIATION');

    const after = await get(h(), `/api/v1/agreements/${agreementId}`, owner.token);
    expect(after.statusCode).toBe(200);
    const restored = (after.json().sections as Array<{ code: string; body: string }>).find((s) => s.code === target.code);
    expect(restored?.body).toBe(target.body);
    expect(restored?.body).not.toBe('STALE WORKING COPY');
    // Fields should still be present (restored from snapshot).
    expect((after.json().fields as Array<unknown>).length).toBe(beforeFields.length);
  });
});
