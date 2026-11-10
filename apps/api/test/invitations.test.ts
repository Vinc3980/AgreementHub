/**
 * Invitation workflow: token delivered once, hash-only storage, email
 * binding, single use, expiry.
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  firstTemplateId,
  get,
  post,
  registerUser,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

async function invite(
  agreementId: string,
  ownerToken: string,
  email: string,
  role = 'SIGNER',
) {
  return post(
    h(),
    `/api/v1/agreements/${agreementId}/parties`,
    { email, role },
    ownerToken,
  );
}

describe('invitation workflow', () => {
  it('returns the raw token exactly once and stores only its SHA-256 hash', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const inviteeEmail = uniqueEmail('invitee');

    const res = await invite(agreement.id, owner.token, inviteeEmail);
    expect(res.statusCode).toBe(201);
    const raw = res.json().invitation.token as string;
    expect(raw.length).toBeGreaterThanOrEqual(32);

    const { rows } = await h().db.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(raw);

    // The raw token must never appear in any subsequent API read.
    const parties = await get(h(), `/api/v1/agreements/${agreement.id}/parties`, owner.token);
    expect(parties.body).not.toContain(raw);
    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, owner.token);
    expect(audit.body).not.toContain(raw);
  });

  it('rejects a duplicate invite for an existing party email', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const email = uniqueEmail('dup-invite');

    expect((await invite(agreement.id, owner.token, email)).statusCode).toBe(201);
    const again = await invite(agreement.id, owner.token, email);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('PARTY_EXISTS');
  });

  it('links the invited user on acceptance and records the audit event', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const inviteeEmail = uniqueEmail('acceptor');

    const inviteRes = await invite(agreement.id, owner.token, inviteeEmail);
    const raw = inviteRes.json().invitation.token as string;

    const invitee = await registerUser(h(), inviteeEmail);
    const accept = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: raw },
      invitee.token,
    );
    expect(accept.statusCode).toBe(200);
    expect(accept.json().agreementId).toBe(agreement.id);
    expect(accept.json().status).toBe('DRAFT');

    // Party linked to the account and now visible to them.
    const { rows } = await h().db.query<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM agreement_parties WHERE agreement_id = $1 AND lower(email) = lower($2)`,
      [agreement.id, inviteeEmail],
    );
    expect(rows[0]?.user_id).toBe(invitee.userId);
    expect(rows[0]?.status).toBe('VIEWED');

    const visible = await get(h(), `/api/v1/agreements/${agreement.id}`, invitee.token);
    expect(visible.statusCode).toBe(200);

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, owner.token);
    const types = (audit.json().events as Array<{ eventType: string }>).map((e) => e.eventType);
    expect(types).toContain('PARTY_INVITED');
    expect(types).toContain('INVITATION_ACCEPTED');
  });

  it('rejects an invitation presented by a different email address', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const intended = uniqueEmail('intended');
    const attacker = await registerUser(h());

    const inviteRes = await invite(agreement.id, owner.token, intended);
    const raw = inviteRes.json().invitation.token as string;

    const stolen = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: raw },
      attacker.token,
    );
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().code).toBe('FORBIDDEN');

    // Attacker gained no visibility.
    const read = await get(h(), `/api/v1/agreements/${agreement.id}`, attacker.token);
    expect(read.statusCode).toBe(404);
  });

  it('allows a single use only (replay ⇒ 409 INVITATION_USED)', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const email = uniqueEmail('replay');

    const inviteRes = await invite(agreement.id, owner.token, email);
    const raw = inviteRes.json().invitation.token as string;
    const user = await registerUser(h(), email);

    const first = await post(h(), '/api/v1/parties/accept-invitation', { token: raw }, user.token);
    expect(first.statusCode).toBe(200);

    const second = await post(h(), '/api/v1/parties/accept-invitation', { token: raw }, user.token);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('INVITATION_USED');
  });

  it('rejects an expired invitation (409 INVITATION_EXPIRED)', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const email = uniqueEmail('expired');

    const inviteRes = await invite(agreement.id, owner.token, email);
    const raw = inviteRes.json().invitation.token as string;
    const user = await registerUser(h(), email);

    // Simulate the TTL lapsing.
    await h().db.query(`UPDATE invitations SET expires_at = now() - interval '1 hour'`);

    const res = await post(h(), '/api/v1/parties/accept-invitation', { token: raw }, user.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVITATION_EXPIRED');
  });

  it('rejects an unknown or revoked token with 404', async () => {
    const owner = await registerUser(h());
    const user = await registerUser(h());

    const res = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: 'definitely-not-a-real-token' },
      user.token,
    );
    expect(res.statusCode).toBe(404);

    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const inviteRes = await invite(agreement.id, owner.token, uniqueEmail('revoked'));
    const raw = inviteRes.json().invitation.token as string;
    const invitee = await registerUser(h(), inviteRes.json().party.email);
    await h().db.query(`UPDATE invitations SET revoked_at = now()`);

    const revoked = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: raw },
      invitee.token,
    );
    expect(revoked.statusCode).toBe(404);
  });

  it('only the agreement manager can invite (signer party cannot)', async () => {
    const owner = await registerUser(h());
    const signer = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const inviteRes = await invite(agreement.id, owner.token, signer.email);
    const raw = inviteRes.json().invitation.token as string;
    await post(h(), '/api/v1/parties/accept-invitation', { token: raw }, signer.token);

    const res = await invite(agreement.id, signer.token, uniqueEmail('nope'));
    expect(res.statusCode).toBe(403);
  });
});
