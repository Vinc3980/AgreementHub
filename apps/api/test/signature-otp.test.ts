/**
 * Email OTP signing (audit Phase 3).
 *
 * The code is generated server-side, delivered by email, bound to
 * agreement + version + party + address, single-use, expiring and attempt
 * limited. Only a consumed code may produce EMAIL_OTP_VERIFIED; session
 * signatures must never claim independent verification.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { consumeSignatureOtp } from '../src/services/signatureOtp.js';
import {
  get,
  latestEmailFor,
  post,
  registerUser,
  setupAwaitingSignatures,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

async function currentVersionId(agreementId: string): Promise<string> {
  const { rows } = await h().db.query<{ current_version_id: string }>(
    `SELECT current_version_id FROM agreements WHERE id = $1`,
    [agreementId],
  );
  return rows[0]!.current_version_id;
}

async function partyId(agreementId: string, userId: string): Promise<string> {
  const { rows } = await h().db.query<{ id: string }>(
    `SELECT id FROM agreement_parties WHERE agreement_id = $1 AND user_id = $2`,
    [agreementId, userId],
  );
  return rows[0]!.id;
}

async function requestOtp(agreementId: string, token: string) {
  return post(h(), '/api/v1/signatures/otp', { agreementId }, token);
}

async function emailedCode(email: string): Promise<string> {
  const queued = await latestEmailFor(h(), email, 'SIGNATURE_OTP');
  expect(queued).not.toBeNull();
  const code = String(queued!.payload.code);
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

function sign(
  agreementId: string,
  token: string,
  body: Record<string, unknown> = {},
) {
  return post(
    h(),
    '/api/v1/signatures',
    { agreementId, consent: true, ...body },
    token,
  );
}

describe('email OTP signing', () => {
  it('emails a six-digit code and never returns it from the API', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await requestOtp(setup.agreementId, setup.counterparty.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sentTo: string; expiresAt: string; expiresMinutes: number };
    expect(body.expiresMinutes).toBe(10);
    expect(body.expiresAt).toBeTruthy();
    // Address is masked, not echoed in full.
    expect(body.sentTo).not.toBe(setup.counterEmail);
    expect(body.sentTo).toContain('@');

    const code = await emailedCode(setup.counterEmail);
    expect(res.body).not.toContain(code);

    // The code is stored hashed, never in clear text.
    const { rows } = await h().db.query<{ otp_hash: string }>(
      `SELECT otp_hash FROM signature_otps WHERE agreement_id = $1`,
      [setup.agreementId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.otp_hash).not.toContain(code);
  });

  it('requires the code for EMAIL_OTP and rejects a wrong code', async () => {
    const setup = await setupAwaitingSignatures(h());
    const missing = await sign(setup.agreementId, setup.counterparty.token, {
      method: 'EMAIL_OTP',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('VALIDATION_FAILED');

    expect((await requestOtp(setup.agreementId, setup.counterparty.token)).statusCode).toBe(200);
    const wrong = await sign(setup.agreementId, setup.counterparty.token, {
      method: 'EMAIL_OTP',
      otpCode: '000000',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().detail).toMatch(/incorrect/i);

    // The correct code still works after one failed attempt.
    const code = await emailedCode(setup.counterEmail);
    const ok = await sign(setup.agreementId, setup.counterparty.token, {
      method: 'EMAIL_OTP',
      otpCode: code,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().signature.method).toBe('EMAIL_OTP');
    expect(ok.json().signature.identityAssurance).toBe('EMAIL_OTP_VERIFIED');

    const { rows } = await h().db.query<{
      identity_assurance: string;
      payload_snapshot: Record<string, unknown>;
      request_id: string | null;
    }>(
      `SELECT identity_assurance, payload_snapshot, request_id
         FROM signatures WHERE agreement_id = $1 AND signer_email = $2`,
      [setup.agreementId, setup.counterEmail],
    );
    expect(rows[0]!.identity_assurance).toBe('EMAIL_OTP_VERIFIED');
    expect(rows[0]!.payload_snapshot.method).toBe('EMAIL_OTP');
    expect(rows[0]!.payload_snapshot.versionId).toBe(
      await currentVersionId(setup.agreementId),
    );
    expect(rows[0]!.request_id).toBeTruthy();
  });

  it('never claims verified identity for session-only signatures', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await sign(setup.agreementId, setup.counterparty.token, { method: 'SESSION' });
    expect(res.statusCode).toBe(201);
    expect(res.json().signature.identityAssurance).toBe('AUTHENTICATED_SESSION');

    const { rows } = await h().db.query<{ identity_assurance: string }>(
      `SELECT identity_assurance FROM signatures WHERE agreement_id = $1`,
      [setup.agreementId],
    );
    expect(rows[0]!.identity_assurance).toBe('AUTHENTICATED_SESSION');
  });

  it('consumes a code exactly once', async () => {
    const setup = await setupAwaitingSignatures(h());
    await requestOtp(setup.agreementId, setup.counterparty.token);
    const code = await emailedCode(setup.counterEmail);
    const input = {
      agreementId: setup.agreementId,
      versionId: await currentVersionId(setup.agreementId),
      partyId: await partyId(setup.agreementId, setup.counterparty.userId),
      signerEmail: setup.counterEmail,
      code,
    };
    await expect(consumeSignatureOtp(h().db, input)).resolves.toBeUndefined();
    await expect(consumeSignatureOtp(h().db, input)).rejects.toThrow(/invalid or expired/i);
  });

  it('rejects an expired code', async () => {
    const setup = await setupAwaitingSignatures(h());
    await requestOtp(setup.agreementId, setup.counterparty.token);
    const code = await emailedCode(setup.counterEmail);
    await h().db.query(
      `UPDATE signature_otps SET expires_at = now() - interval '1 minute'`,
    );

    const res = await sign(setup.agreementId, setup.counterparty.token, {
      method: 'EMAIL_OTP',
      otpCode: code,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/invalid or expired/i);
  });

  it('locks the code after too many failed attempts', async () => {
    const setup = await setupAwaitingSignatures(h());
    await requestOtp(setup.agreementId, setup.counterparty.token);
    const input = {
      agreementId: setup.agreementId,
      versionId: await currentVersionId(setup.agreementId),
      partyId: await partyId(setup.agreementId, setup.counterparty.userId),
      signerEmail: setup.counterEmail,
      code: '999999',
    };
    for (let i = 0; i < 5; i += 1) {
      await expect(consumeSignatureOtp(h().db, input)).rejects.toThrow(/incorrect/i);
    }

    // The sixth attempt is refused before the comparison, even if the code
    // is now correct; the user must request a fresh code.
    const correct = await emailedCode(setup.counterEmail);
    await expect(
      consumeSignatureOtp(h().db, { ...input, code: correct }),
    ).rejects.toThrow(/too many/i);

    const res = await sign(setup.agreementId, setup.counterparty.token, {
      method: 'EMAIL_OTP',
      otpCode: correct,
    });
    expect(res.statusCode).toBe(400);
  });

  it('binds the code to agreement, version, party and email', async () => {
    const setup = await setupAwaitingSignatures(h());
    await requestOtp(setup.agreementId, setup.counterparty.token);
    const code = await emailedCode(setup.counterEmail);
    const base = {
      agreementId: setup.agreementId,
      versionId: await currentVersionId(setup.agreementId),
      partyId: await partyId(setup.agreementId, setup.counterparty.userId),
      signerEmail: setup.counterEmail,
      code,
    };

    // Same code, different version → no matching row.
    await expect(
      consumeSignatureOtp(h().db, { ...base, versionId: randomUUID() }),
    ).rejects.toThrow(/invalid or expired/i);

    // Same code, different signer address → no matching row.
    await expect(
      consumeSignatureOtp(h().db, { ...base, signerEmail: 'someone-else@example.com' }),
    ).rejects.toThrow(/invalid or expired/i);

    // The original binding still works.
    await expect(consumeSignatureOtp(h().db, base)).resolves.toBeUndefined();
  });

  it('rate-limits requests per signer and version', async () => {
    const setup = await setupAwaitingSignatures(h());
    expect((await requestOtp(setup.agreementId, setup.counterparty.token)).statusCode).toBe(200);

    const tooSoon = await requestOtp(setup.agreementId, setup.counterparty.token);
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().code).toBe('RATE_LIMITED');

    const firstCode = await emailedCode(setup.counterEmail);
    await h().db.query(
      `UPDATE signature_otps SET created_at = now() - interval '2 minutes'`,
    );
    expect((await requestOtp(setup.agreementId, setup.counterparty.token)).statusCode).toBe(200);
    const secondCode = await emailedCode(setup.counterEmail);

    // The old code was invalidated by the new request.
    if (secondCode !== firstCode) {
      const stale = await sign(setup.agreementId, setup.counterparty.token, {
        method: 'EMAIL_OTP',
        otpCode: firstCode,
      });
      expect(stale.statusCode).toBe(400);
    }
  });

  it('only linked signers can request a code', async () => {
    const setup = await setupAwaitingSignatures(h());
    const outsider = await registerUser(h());
    const res = await requestOtp(setup.agreementId, outsider.token);
    expect(res.statusCode).toBe(404);

    const unauthenticated = await post(h(), '/api/v1/signatures/otp', {
      agreementId: setup.agreementId,
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
