/**
 * Dashboard aggregates (counts, pending actions, recent activity) and the
 * agreement list filters the frontend exposes (date range, party role).
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  firstTemplateId,
  get,
  post,
  registerUser,
  setupAwaitingSignatures,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('agreement list filters', () => {
  it('filters by created-at date range', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    await createAgreement(h(), user.token, templateId, 'Dated Agreement');

    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

    const inRange = await get(
      h(),
      `/api/v1/agreements?dateFrom=${encodeURIComponent(yesterday)}&dateTo=${encodeURIComponent(now)}`,
      user.token,
    );
    expect(inRange.statusCode).toBe(200);
    expect(inRange.json().agreements).toHaveLength(1);

    const future = await get(
      h(),
      `/api/v1/agreements?dateFrom=${encodeURIComponent(tomorrow)}`,
      user.token,
    );
    expect(future.json().agreements).toHaveLength(0);

    const past = await get(
      h(),
      `/api/v1/agreements?dateTo=${encodeURIComponent(yesterday)}`,
      user.token,
    );
    expect(past.json().agreements).toHaveLength(0);
  });

  it('filters by the caller party role', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId, 'Role Filter');

    const asOwner = await get(h(), '/api/v1/agreements?role=OWNER', owner.token);
    expect(asOwner.json().agreements.map((a: { id: string }) => a.id)).toContain(agreement.id);

    const asSigner = await get(h(), '/api/v1/agreements?role=SIGNER', owner.token);
    expect(asSigner.json().agreements).toHaveLength(0);

    // The invited counterparty sees it as SIGNER.
    const counterEmail = uniqueEmail('rolefilter');
    const invite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: counterEmail, role: 'SIGNER' },
      owner.token,
    );
    const counterparty = await registerUser(h(), counterEmail);
    await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: invite.json().invitation.token },
      counterparty.token,
    );

    const counterAsSigner = await get(h(), '/api/v1/agreements?role=SIGNER', counterparty.token);
    expect(counterAsSigner.json().agreements.map((a: { id: string }) => a.id)).toContain(
      agreement.id,
    );
    const counterAsOwner = await get(h(), '/api/v1/agreements?role=OWNER', counterparty.token);
    expect(counterAsOwner.json().agreements).toHaveLength(0);
  });
});

describe('dashboard', () => {
  it('starts empty for a brand-new account', async () => {
    const user = await registerUser(h());
    const res = await get(h(), '/api/v1/dashboard', user.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toMatchObject({
      total: 0,
      drafts: 0,
      awaitingAction: 0,
      active: 0,
      expiring: 0,
      expired: 0,
    });
    expect(res.json().pendingActions).toHaveLength(0);
    expect(res.json().recentActivity).toHaveLength(0);
  });

  it('counts drafts and surfaces recent activity', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    await createAgreement(h(), user.token, templateId, 'My Draft');

    const res = await get(h(), '/api/v1/dashboard', user.token);
    expect(res.json().counts).toMatchObject({ total: 1, drafts: 1, awaitingAction: 0 });

    const activity = res.json().recentActivity as Array<{
      eventType: string;
      publicId: string;
    }>;
    // Setup fills required template fields, so later events (field updates,
    // party views) may follow creation, the creation event must be present.
    const created = activity.find((a) => a.eventType === 'AGREEMENT_CREATED');
    expect(created).toBeTruthy();
    expect(created?.publicId).toMatch(/^AGR-GH-/);
  });

  it('shows a REVIEW pending action for the creator once submitted', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId, 'Needs Review');
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, owner.token);

    const res = await get(h(), '/api/v1/dashboard', owner.token);
    const actions = res.json().pendingActions as Array<{ action: string; agreementId: string }>;
    expect(actions.some((a) => a.action === 'REVIEW' && a.agreementId === agreement.id)).toBe(true);
    expect(res.json().counts.awaitingAction).toBe(1);
    expect(res.json().counts.drafts).toBe(0);
  });

  it('shows an APPROVE pending action while an approval is awaited', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId, 'Awaiting Approval');
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, owner.token);
    await post(h(), '/api/v1/approvals/request', { agreementId: agreement.id }, owner.token);

    const res = await get(h(), '/api/v1/dashboard', owner.token);
    const actions = res.json().pendingActions as Array<{ action: string }>;
    expect(actions.some((a) => a.action === 'APPROVE')).toBe(true);

    // Once approved the action disappears and the flow advances.
    await post(
      h(),
      '/api/v1/approvals',
      { agreementId: agreement.id, decision: 'APPROVED' },
      owner.token,
    );
    const after = await get(h(), '/api/v1/dashboard', owner.token);
    const afterActions = after.json().pendingActions as Array<{ action: string }>;
    expect(afterActions.some((a) => a.action === 'APPROVE')).toBe(false);
    expect(afterActions.some((a) => a.action === 'SIGN')).toBe(true);
  });

  it('shows SIGN pending actions for every unsigned required signer', async () => {
    const setup = await setupAwaitingSignatures(h());

    const ownerDash = await get(h(), '/api/v1/dashboard', setup.owner.token);
    expect(ownerDash.statusCode).toBe(200);
    expect(ownerDash.json().counts).toMatchObject({
      total: 1,
      awaitingSignatures: 1,
      awaitingAction: 1,
    });
    const ownerActions = ownerDash.json().pendingActions as Array<{
      action: string;
      status: string;
    }>;
    expect(ownerActions.some((a) => a.action === 'SIGN' && a.status === 'AWAITING_SIGNATURES')).toBe(
      true,
    );

    const counterDash = await get(h(), '/api/v1/dashboard', setup.counterparty.token);
    expect(counterDash.json().counts.awaitingAction).toBe(1);
    const counterActions = counterDash.json().pendingActions as Array<{ action: string }>;
    expect(counterActions.some((a) => a.action === 'SIGN')).toBe(true);

    // Both sign → actions clear and the agreement finalizes to ACTIVE.
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
    await post(h(), `/api/v1/agreements/${setup.agreementId}/finalize`, {}, setup.owner.token);

    const done = await get(h(), '/api/v1/dashboard', setup.owner.token);
    expect(done.json().counts).toMatchObject({
      active: 1,
      awaitingSignatures: 0,
      awaitingAction: 0,
    });
    expect(done.json().pendingActions).toHaveLength(0);
  });

  it('never leaks another account’s agreements or activity', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    await createAgreement(h(), owner.token, templateId, 'Private Deal');
    await createAgreement(h(), owner.token, templateId, 'Second Deal');

    const stranger = await registerUser(h());
    const mine = await createAgreement(h(), stranger.token, templateId, 'Stranger Deal');

    const ownerDash = await get(h(), '/api/v1/dashboard', owner.token);
    expect(ownerDash.json().counts.total).toBe(2);
    expect(
      (ownerDash.json().recentActivity as Array<{ title: string }>).every(
        (e) => e.title !== 'Stranger Deal',
      ),
    ).toBe(true);

    const strangerDash = await get(h(), '/api/v1/dashboard', stranger.token);
    expect(strangerDash.json().counts.total).toBe(1);
    const titles = (strangerDash.json().recentActivity as Array<{ title: string }>).map(
      (e) => e.title,
    );
    expect(titles).not.toContain('Private Deal');
    expect(strangerDash.json().counts.awaitingAction).toBe(0);

    // Anonymous callers are rejected outright.
    const anon = await get(h(), '/api/v1/dashboard');
    expect(anon.statusCode).toBe(401);

    // Sanity: the stranger's own agreement exists and is theirs.
    expect(mine.agreement.publicId).toMatch(/^AGR-GH-/);
  });
});
