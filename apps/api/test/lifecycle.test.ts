/**
 * Agreement status transitions: legal moves succeed, illegal moves and
 * missing reasons produce INVALID_TRANSITION (409), terminal states are final.
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  firstTemplateId,
  get,
  post,
  registerUser,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('status transitions', () => {
  it('allows DRAFT → REVIEW and records the submission in the audit trail', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'REVIEW' },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agreement.status).toBe('REVIEW');

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, user.token);
    const types = (audit.json().events as Array<{ eventType: string }>).map((e) => e.eventType);
    expect(types).toContain('AGREEMENT_SUBMITTED');
  });

  it('rejects an illegal jump DRAFT → ACTIVE with 409 INVALID_TRANSITION', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'ACTIVE' },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_TRANSITION');

    // Status unchanged.
    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    expect(detail.json().agreement.status).toBe('DRAFT');
  });

  it('rejects DRAFT → AWAITING_SIGNATURES (approvals must be recorded first)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'AWAITING_SIGNATURES' },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_TRANSITION');
  });

  it('rejects self-transitions (already in that status)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'DRAFT' },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_TRANSITION');
    expect(res.json().detail).toMatch(/already in status/i);
  });

  it('requires a reason to cancel (assertTransition guard)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const noReason = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'CANCELLED' },
      user.token,
    );
    expect(noReason.statusCode).toBe(409);
    expect(noReason.json().code).toBe('INVALID_TRANSITION');
    expect(noReason.json().detail).toMatch(/reason is required/i);

    const withReason = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'CANCELLED', reason: 'Scope no longer needed' },
      user.token,
    );
    expect(withReason.statusCode).toBe(200);
    expect(withReason.json().agreement.status).toBe('CANCELLED');
    expect(withReason.json().agreement.closedReason).toBe('Scope no longer needed');
  });

  it('requires a reason on the dedicated cancel endpoint (400 REASON_REQUIRED)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const missing = await post(h(), `/api/v1/agreements/${agreement.id}/cancel`, {}, user.token);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('REASON_REQUIRED');

    const tooShort = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/cancel`,
      { reason: 'x' },
      user.token,
    );
    expect(tooShort.statusCode).toBe(400);

    const ok = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/cancel`,
      { reason: 'Mutually agreed to stop' },
      user.token,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().agreement.status).toBe('CANCELLED');
  });

  it('treats CANCELLED as terminal: no further transitions', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'CANCELLED', reason: 'abandoned draft' },
      user.token,
    );

    for (const to of ['DRAFT', 'REVIEW', 'ACTIVE', 'TERMINATED'] as const) {
      const res = await post(
        h(),
        `/api/v1/agreements/${agreement.id}/status`,
        { to, reason: 'trying to revive' },
        user.token,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_TRANSITION');
    }

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    expect(detail.json().agreement.status).toBe('CANCELLED');
  });

  it('rejects terminate from a pre-signature status', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/terminate`,
      { reason: 'party pulled out early' },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_TRANSITION');
  });

  it('supports the review back-and-forth: REVIEW → DRAFT → REVIEW', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    expect(
      (
        await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token)
      ).statusCode,
    ).toBe(200);

    const back = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'DRAFT' },
      user.token,
    );
    expect(back.statusCode).toBe(200);
    expect(back.json().agreement.status).toBe('DRAFT');

    // And drafts are editable again after returning to DRAFT.
    const edit = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'REVIEW' },
      user.token,
    );
    expect(edit.statusCode).toBe(200);
  });

  it('rejects transitions by a non-manager party', async () => {
    const owner = await registerUser(h());
    const signer = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const invite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: signer.email, role: 'SIGNER' },
      owner.token,
    );
    const raw = invite.json().invitation.token as string;
    await post(h(), '/api/v1/parties/accept-invitation', { token: raw }, signer.token);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'REVIEW' },
      signer.token,
    );
    expect(res.statusCode).toBe(403);
  });

  it('validates the transition target against the allowed enum', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'BANANA' },
      user.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });
});
