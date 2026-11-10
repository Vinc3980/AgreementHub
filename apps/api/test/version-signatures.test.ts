/**
 * Version-bound signatures (audit Phase 2).
 *
 * A signature is bound to the exact document version. Signatures collected for
 * v1 never satisfy v2 after an amendment: every required party signs again,
 * reminders/notifications are re-sent, and finalization validates the current
 * version only.
 */
import { describe, expect, it } from 'vitest';
import {
  get,
  post,
  setupAwaitingSignatures,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

async function sign(agreementId: string, token: string) {
  return post(
    h(),
    '/api/v1/signatures',
    { agreementId, consent: true, method: 'SESSION' },
    token,
  );
}

/** Finalize v1 after explicitly requesting signatures from both parties. */
async function finalizedV1() {
  const setup = await setupAwaitingSignatures(h());
  const request = await post(
    h(),
    '/api/v1/signatures/request',
    { agreementId: setup.agreementId },
    setup.owner.token,
  );
  expect(request.statusCode).toBe(200);
  expect(request.json().notified).toBe(2);

  expect((await sign(setup.agreementId, setup.owner.token)).statusCode).toBe(201);
  expect((await sign(setup.agreementId, setup.counterparty.token)).statusCode).toBe(201);

  const fin = await post(
    h(),
    `/api/v1/agreements/${setup.agreementId}/finalize`,
    {},
    setup.owner.token,
  );
  expect(fin.statusCode).toBe(200);
  return {
    setup,
    final: fin.json() as { versionId: string; versionNumber: number; documentHash: string },
  };
}

/** Take an ACTIVE agreement through an amendment back to AWAITING_SIGNATURES. */
async function amendAndRequestSignatures(agreementId: string, ownerToken: string) {
  const amend = await post(h(), `/api/v1/agreements/${agreementId}/amendments`, {}, ownerToken);
  expect(amend.statusCode).toBe(201);
  const version = amend.json().version as { id: string; versionNumber: number };

  expect(
    (
      await post(
        h(),
        `/api/v1/agreements/${agreementId}/status`,
        { to: 'REVIEW' },
        ownerToken,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await post(h(), '/api/v1/approvals/request', { agreementId }, ownerToken)).statusCode,
  ).toBe(200);
  expect(
    (
      await post(
        h(),
        '/api/v1/approvals',
        { agreementId, decision: 'APPROVED' },
        ownerToken,
      )
    ).statusCode,
  ).toBe(200);

  const request = await post(h(), '/api/v1/signatures/request', { agreementId }, ownerToken);
  expect(request.statusCode).toBe(200);
  expect(request.json().versionId).toBe(version.id);
  expect(request.json().notified).toBe(2);
  return version;
}

describe('amendments and version-bound signatures', () => {
  it('does not let v1 signatures satisfy the amended v2', async () => {
    const { setup, final } = await finalizedV1();
    const version2 = await amendAndRequestSignatures(setup.agreementId, setup.owner.token);
    expect(version2.versionNumber).toBe(2);

    const status = await get(
      h(),
      `/api/v1/agreements/${setup.agreementId}/signature-status`,
      setup.owner.token,
    );
    expect(status.statusCode).toBe(200);
    expect(status.json().versionId).toBe(version2.id);
    expect(status.json().required).toBe(2);
    expect(status.json().signed).toBe(0);

    // Finalization checks the current version, not the archived v1 signatures.
    const early = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/finalize`,
      {},
      setup.owner.token,
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('MISSING_SIGNATURES');
    expect(early.json().errors.missing).toHaveLength(2);

    // Both parties must sign the new version.
    expect((await sign(setup.agreementId, setup.owner.token)).statusCode).toBe(201);
    expect((await sign(setup.agreementId, setup.counterparty.token)).statusCode).toBe(201);

    const fin = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/finalize`,
      {},
      setup.owner.token,
    );
    expect(fin.statusCode).toBe(200);
    expect(fin.json().versionNumber).toBe(2);

    // Signature rows remain bound to their own version.
    const { rows } = await h().db.query<{ version_id: string; count: number }>(
      `SELECT version_id, COUNT(*)::int AS count
         FROM signatures WHERE agreement_id = $1
        GROUP BY version_id ORDER BY version_id`,
      [setup.agreementId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.version_id === final.versionId)!.count).toBe(2);
    expect(rows.find((r) => r.version_id === version2.id)!.count).toBe(2);

    // Public verification covers the current final version only.
    const verify = await get(h(), `/api/v1/verification/${setup.publicId}`);
    expect(verify.statusCode).toBe(200);
    expect(verify.json().version).toBe(2);
    expect(verify.json().signatureIntegrity).toBe('VERIFIED');
    expect(verify.json().signatures).toEqual({ total: 2, verified: 2 });
  });

  it('re-sends signature requests (in-app and email) for the new version', async () => {
    const { setup, final } = await finalizedV1();
    const version2 = await amendAndRequestSignatures(setup.agreementId, setup.owner.token);

    const party = await h().db.query<{ id: string }>(
      `SELECT id FROM agreement_parties WHERE agreement_id = $1 AND user_id = $2`,
      [setup.agreementId, setup.counterparty.userId],
    );
    const partyId = party.rows[0]!.id;

    const { rows } = await h().db.query<{ type: string; dedupe_key: string }>(
      `SELECT type, dedupe_key FROM notifications
        WHERE user_id = $1 AND agreement_id = $2 AND type = 'SIGNATURE_REQUESTED'
        ORDER BY created_at`,
      [setup.counterparty.userId, setup.agreementId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `sigreq:${final.versionId}:${partyId}`,
      `sigreq:${version2.id}:${partyId}`,
    ]);

    const outbox = await h().db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM email_outbox
        WHERE lower(to_email) = lower($1) AND template = 'SIGNATURE_REQUEST'`,
      [setup.counterEmail],
    );
    expect(outbox.rows[0]!.count).toBe(2);
  });

  it('keeps archived versions immutable while new versions are signed', async () => {
    const { setup, final } = await finalizedV1();
    await amendAndRequestSignatures(setup.agreementId, setup.owner.token);

    const archived = await h().db.query<{ status: string; document_hash: string }>(
      `SELECT status, document_hash FROM agreement_versions WHERE id = $1`,
      [final.versionId],
    );
    expect(archived.rows[0]!.status).toBe('FINAL');
    expect(archived.rows[0]!.document_hash).toBe(final.documentHash);

    // Tampering with a sealed version is denied by the DB trigger.
    await expect(
      h().db.query(
        `UPDATE agreement_versions SET content = '{}'::jsonb WHERE id = $1`,
        [final.versionId],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses signature requests that target a superseded version', async () => {
    const { setup, final } = await finalizedV1();
    await amendAndRequestSignatures(setup.agreementId, setup.owner.token);

    // v1 is no longer APPROVED, and it is not the current version.
    const res = await post(
      h(),
      '/api/v1/signatures/request',
      { agreementId: setup.agreementId, versionId: final.versionId },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('VERSION_NOT_APPROVED');
  });

  it('never counts signatures from a different agreement version', async () => {
    // Two independent agreements: signing one must not affect the other's
    // required-signature count.
    const a = await setupAwaitingSignatures(h());
    const b = await setupAwaitingSignatures(h());
    expect((await sign(a.agreementId, a.owner.token)).statusCode).toBe(201);

    const status = await get(
      h(),
      `/api/v1/agreements/${b.agreementId}/signature-status`,
      b.owner.token,
    );
    expect(status.json().required).toBe(2);
    expect(status.json().signed).toBe(0);

    const fin = await post(
      h(),
      `/api/v1/agreements/${b.agreementId}/finalize`,
      {},
      b.owner.token,
    );
    expect(fin.statusCode).toBe(409);
  });
});
