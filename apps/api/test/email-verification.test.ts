/**
 * Email verification (audit Phase 1).
 *
 * Registration must never mark an address verified. Tokens are delivered by
 * email, single-use, expiring, and required before an invited user can accept.
 */
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/lib/tokens.js';
import * as outbox from '../src/services/outbox.js';
import {
  createAgreement,
  firstTemplateId,
  get,
  latestEmailFor,
  post,
  registerUnverifiedUser,
  registerUser,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('email verification', () => {
  it('does not auto-verify a new account and never returns the raw token', async () => {
    const email = uniqueEmail('unverified');
    const res = await post(h(), '/api/v1/auth/register', {
      email,
      password: 'Password123',
      displayName: 'Unverified User',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { emailVerifiedAt: string | null } };
    expect(body.user.emailVerifiedAt).toBeNull();
    expect(body.token).toBeTruthy();
    expect(body).not.toHaveProperty('verificationToken');

    const me = await get(h(), '/api/v1/users/me', body.token);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.emailVerifiedAt).toBeNull();

    const queued = await latestEmailFor(h(), email, 'EMAIL_VERIFICATION');
    expect(queued).not.toBeNull();
    expect(String(queued!.payload.token)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The API response contains a session token, but never the email token.
    expect(res.body).not.toContain(String(queued!.payload.token));
  });

  it('verifies an address exactly once and rejects reused or bogus tokens', async () => {
    const email = uniqueEmail('verify');
    const user = await registerUnverifiedUser(h(), email);
    const queued = await latestEmailFor(h(), email, 'EMAIL_VERIFICATION');
    const token = String(queued!.payload.token);

    const bogus = await post(h(), '/api/v1/auth/verify-email', { token: 'x'.repeat(40) });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().code).toBe('INVALID_VERIFICATION_TOKEN');

    const ok = await post(h(), '/api/v1/auth/verify-email', { token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().verified).toBe(true);

    const me = await get(h(), '/api/v1/users/me', user.token);
    expect(me.json().user.emailVerifiedAt).toBeTruthy();

    // Replay is refused (single-use token).
    const replay = await post(h(), '/api/v1/auth/verify-email', { token });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().code).toBe('INVALID_VERIFICATION_TOKEN');

    // Verification is audited.
    const { rows } = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_events WHERE event_type = 'EMAIL_VERIFIED'`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('expires verification tokens', async () => {
    const email = uniqueEmail('expired');
    await registerUnverifiedUser(h(), email);
    const token = String((await latestEmailFor(h(), email, 'EMAIL_VERIFICATION'))!.payload.token);

    await h().db.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'`,
    );
    const res = await post(h(), '/api/v1/auth/verify-email/confirm', { token });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_VERIFICATION_TOKEN');
  });

  it('stores only the SHA-256 token hash (never the raw token)', async () => {
    const email = uniqueEmail('hashonly');
    await registerUnverifiedUser(h(), email);
    const token = String((await latestEmailFor(h(), email, 'EMAIL_VERIFICATION'))!.payload.token);
    const { rows } = await h().db.query<{ token_hash: string; token?: string }>(
      `SELECT token_hash FROM email_verification_tokens ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.token_hash).toBe(hashToken(token));
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it('registration still succeeds when verification email enqueue fails', async () => {
    const spy = vi.spyOn(outbox, 'enqueueEmail').mockRejectedValueOnce(new Error('mailer down'));
    try {
      const email = uniqueEmail('enqfail');
      const res = await post(h(), '/api/v1/auth/register', {
        email,
        password: 'Password123',
        displayName: 'Resilient User',
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.token).toBeTruthy();
      expect(body.user.emailVerifiedAt).toBeNull();
      // Email could not be sent; user can resend.
      expect(body.emailVerificationSent).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('enforces the resend cooldown and invalidates the previous link', async () => {
    const email = uniqueEmail('resend');
    const user = await registerUnverifiedUser(h(), email);
    const firstToken = String(
      (await latestEmailFor(h(), email, 'EMAIL_VERIFICATION'))!.payload.token,
    );

    const tooSoon = await post(h(), '/api/v1/auth/verify-email/request', {}, user.token);
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().retryAfterSeconds).toBeGreaterThan(0);

    // Simulate the cooldown elapsing (no real waiting in tests).
    await h().db.query(
      `UPDATE email_verification_tokens
          SET created_at = now() - interval '2 minutes'
        WHERE user_id = $1`,
      [user.userId],
    );
    const resent = await post(h(), '/api/v1/auth/verify-email/request', {}, user.token);
    expect(resent.statusCode).toBe(200);
    const resentBody = resent.json();
    expect(resentBody.sent).toBe(true);
    // Outside production, the API returns a dev verification URL (never in production).
    expect(String(resentBody.devVerifyUrl)).toContain('/verify-email?token=');

    const secondToken = String(
      (await latestEmailFor(h(), email, 'EMAIL_VERIFICATION'))!.payload.token,
    );
    expect(secondToken).not.toBe(firstToken);

    // The first link was invalidated when the new one was issued.
    const old = await post(h(), '/api/v1/auth/verify-email', { token: firstToken });
    expect(old.statusCode).toBe(400);

    const fresh = await post(h(), '/api/v1/auth/verify-email', { token: secondToken });
    expect(fresh.statusCode).toBe(200);

    // Already verified accounts do not get more emails.
    const already = await post(h(), '/api/v1/auth/verification-email/resend', {}, user.token);
    expect(already.statusCode).toBe(200);
    expect(already.json().alreadyVerified).toBe(true);
  });

  it('blocks invitation acceptance until the invited address is verified', async () => {
    const owner = await registerUser(h(), uniqueEmail('owner'));
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const inviteeEmail = uniqueEmail('invitee');
    const invite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: inviteeEmail, role: 'SIGNER' },
      owner.token,
    );
    expect(invite.statusCode).toBe(201);
    const inviteToken = invite.json().invitation.token as string;

    // The invitation email is queued for delivery.
    expect(await latestEmailFor(h(), inviteeEmail, 'INVITATION')).not.toBeNull();

    const invitee = await registerUnverifiedUser(h(), inviteeEmail);
    const blocked = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: inviteToken },
      invitee.token,
    );
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail).toBe('EMAIL_NOT_VERIFIED');

    const verifyToken = String(
      (await latestEmailFor(h(), inviteeEmail, 'EMAIL_VERIFICATION'))!.payload.token,
    );
    expect(
      (await post(h(), '/api/v1/auth/verify-email', { token: verifyToken })).statusCode,
    ).toBe(200);

    const accepted = await post(
      h(),
      '/api/v1/parties/accept-invitation',
      { token: inviteToken },
      invitee.token,
    );
    expect(accepted.statusCode).toBe(200);
  });
});
