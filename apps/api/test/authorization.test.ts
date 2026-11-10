/**
 * Authorization: deny-by-default, no IDOR (invisible ⇒ 404), role rules.
 */
import { describe, expect, it } from 'vitest';
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

describe('authorization', () => {
  it('returns 404 (not 403) for an agreement the caller cannot see, no IDOR leak', async () => {
    const alice = await registerUser(h());
    const mallory = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), alice.token, templateId);

    const read = await get(h(), `/api/v1/agreements/${agreement.id}`, mallory.token);
    expect(read.statusCode).toBe(404);
    expect(read.json().code).toBe('NOT_FOUND');

    // Same for mutations and sub-resources: indistinguishable from missing.
    const edit = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { title: 'Hijacked' },
      mallory.token,
    );
    expect(edit.statusCode).toBe(404);

    const parties = await get(h(), `/api/v1/agreements/${agreement.id}/parties`, mallory.token);
    expect(parties.statusCode).toBe(404);

    const status = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'CANCELLED', reason: 'nope' },
      mallory.token,
    );
    expect(status.statusCode).toBe(404);

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, mallory.token);
    expect(audit.statusCode).toBe(404);
  });

  it('rejects unauthenticated access to protected routes with 401', async () => {
    const alice = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), alice.token, templateId);

    expect((await get(h(), '/api/v1/agreements')).statusCode).toBe(401);
    expect((await get(h(), `/api/v1/agreements/${agreement.id}`)).statusCode).toBe(401);
    expect(
      (await post(h(), '/api/v1/agreements', { templateId, title: 'x' })).statusCode,
    ).toBe(401);
  });

  it('forbids creating an agreement in an organization the caller does not belong to', async () => {
    const alice = await registerUser(h());
    const mallory = await registerUser(h());
    const templateId = await firstTemplateId(h().db);

    const res = await post(
      h(),
      '/api/v1/agreements',
      { templateId, title: 'Intruder', orgId: alice.orgId },
      mallory.token,
    );
    expect(res.statusCode).toBe(403);
  });

  it('restricts a linked party to their permitted actions (SIGNER cannot edit or manage)', async () => {
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
    expect(invite.statusCode).toBe(201);
    const rawToken = invite.json().invitation.token as string;
    await post(h(), '/api/v1/parties/accept-invitation', { token: rawToken }, signer.token);

    // Visible now (party), so reads succeed…
    const read = await get(h(), `/api/v1/agreements/${agreement.id}`, signer.token);
    expect(read.statusCode).toBe(200);

    // …but a SIGNER party may not edit content or manage the agreement.
    const edit = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { title: 'Signer edit' },
      signer.token,
    );
    expect(edit.statusCode).toBe(403);

    const inviteMore = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: uniqueEmail('outsider'), role: 'SIGNER' },
      signer.token,
    );
    expect(inviteMore.statusCode).toBe(403);

    const cancel = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/cancel`,
      { reason: 'signer tried to cancel' },
      signer.token,
    );
    expect(cancel.statusCode).toBe(403);
  });

  it('applies org-role read rules: MEMBER without party role sees nothing, REVIEWER can read', async () => {
    const owner = await registerUser(h());
    const member = await registerUser(h());
    const reviewer = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    // Add both as org members with different roles (org-admin action, done
    // directly since org-member management is out of scope for this stage).
    await h().db.query(
      `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,'MEMBER'), ($1,$3,'REVIEWER')`,
      [owner.orgId, member.userId, reviewer.userId],
    );

    const memberRead = await get(h(), `/api/v1/agreements/${agreement.id}`, member.token);
    expect(memberRead.statusCode).toBe(404); // MEMBER needs party membership too

    const reviewerRead = await get(h(), `/api/v1/agreements/${agreement.id}`, reviewer.token);
    expect(reviewerRead.statusCode).toBe(200);

    // Reviewer reads but cannot manage.
    const reviewerInvite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: uniqueEmail('x'), role: 'SIGNER' },
      reviewer.token,
    );
    expect(reviewerInvite.statusCode).toBe(403);
  });

  it('does not let an outsider accept an invitation issued to someone else', async () => {
    const owner = await registerUser(h());
    const invited = await registerUser(h());
    const outsider = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const invite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: invited.email, role: 'SIGNER' },
      owner.token,
    );
    const rawToken = invite.json().invitation.token as string;

    const stolen = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: rawToken },
      outsider.token,
    );
    expect(stolen.statusCode).toBe(403);

    // Outsider still cannot see the agreement.
    const read = await get(h(), `/api/v1/agreements/${agreement.id}`, outsider.token);
    expect(read.statusCode).toBe(404);
  });
});
