/**
 * Verification: recompute the sealed document hash and compare.
 * VERIFIED on intact documents, MISMATCH on tampered content or a wrong
 * supplied hash, NOT_FOUND for unknown IDs, public metadata only.
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  firstTemplateId,
  get,
  post,
  registerUser,
  setupAwaitingSignatures,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

/** Drive a fresh agreement all the way to finalized (ACTIVE) state. */
async function finalizeFresh() {
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
  if (fin.statusCode !== 200) throw new Error(`finalize failed: ${fin.statusCode} ${fin.body}`);
  return { ...setup, finalize: fin.json() as { documentHash: string; versionId: string } };
}

describe('verification hash', () => {
  it('verifies a finalized agreement through the public endpoint (no auth)', async () => {
    const { publicId, finalize } = await finalizeFresh();

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.agreementId).toBe(publicId);
    expect(body.status).toBe('ACTIVE');
    expect(body.version).toBe(1);
    expect(body.integrity).toBe('VERIFIED');
    expect(body.recordState).toBe('VALID');
    expect(body.lifecycleLabel).toBe('Active');
    expect(body.recordMessage).toMatch(/integrity/i);
    expect(body.hashPrefix).toBe(finalize.documentHash.slice(0, 12));
    expect(body.disclaimer).toBeTruthy();

    // Public projection: metadata only, never contents, parties, or hashes in full.
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('sections');
    expect(body).not.toHaveProperty('fields');
    expect(body).not.toHaveProperty('parties');
    expect(res.body).not.toContain(finalize.documentHash);
    expect(res.body).not.toContain('@example.com');
  });

  it('exposes the agreement category as safe metadata', async () => {
    const { publicId } = await finalizeFresh();
    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Category label only, no title, contents, or party data.
    expect(typeof body.category).toBe('string');
    expect(body.category.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('brief');
  });

  it('reports a null category for unknown IDs', async () => {
    const res = await get(h(), `/api/v1/verification/AGR-GH-2026-000999`);
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(false);
    expect(res.json().category).toBeNull();
  });

  it('accepts a matching supplied hash and rejects a wrong one', async () => {
    const { publicId, finalize } = await finalizeFresh();

    const good = await post(
      h(),
      '/api/v1/verification',
      { agreementId: publicId, hash: finalize.documentHash },
      undefined, // endpoint requires auth; reuse a registered session below
    );
    // Unauthenticated => 401 (the endpoint is authenticated by design).
    expect(good.statusCode).toBe(401);

    const user = await registerUser(h());
    const ok = await post(
      h(),
      '/api/v1/verification',
      { agreementId: publicId, hash: finalize.documentHash },
      user.token,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().integrity).toBe('VERIFIED');

    const wrong = await post(
      h(),
      '/api/v1/verification',
      { agreementId: publicId, hash: 'a'.repeat(64) },
      user.token,
    );
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json().integrity).toBe('MISMATCH');
  });

  it('rejects a malformed hash at validation level', async () => {
    const { publicId } = await finalizeFresh();
    const user = await registerUser(h());
    const res = await post(
      h(),
      '/api/v1/verification',
      { agreementId: publicId, hash: 'not-a-hash' },
      user.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('returns NOT_FOUND for an unknown but well-formed Agreement ID', async () => {
    const res = await get(h(), '/api/v1/verification/AGR-GH-2026-999999');
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(false);
    expect(res.json().integrity).toBe('NOT_FOUND');
    expect(res.json().recordState).toBe('UNAVAILABLE');
    expect(res.json().status).toBeNull();
    expect(res.json().recordMessage).toMatch(/reference alone does not confirm authenticity/i);

    // The attempt is recorded for abuse analysis (agreement_id stays NULL).
    const { rows } = await h().db.query<{ result: string; agreement_id: string | null }>(
      `SELECT result, agreement_id FROM verification_records WHERE result = 'NOT_FOUND'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agreement_id).toBeNull();
  });

  it('returns NOT_FOUND for a malformed ID without touching the DB', async () => {
    const res = await get(h(), '/api/v1/verification/not-a-public-id');
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(false);
    expect(res.json().integrity).toBe('NOT_FOUND');
  });

  it('reports NOT_FOUND integrity for an existing but unfinalized agreement', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await get(h(), `/api/v1/verification/${agreement.publicId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
    expect(res.json().integrity).toBe('NOT_FOUND');
    expect(res.json().recordState).toBe('UNAVAILABLE');
    expect(res.json().lifecycleLabel).toBeTruthy();
    expect(res.json().finalizedAt).toBeNull();
    expect(res.json().version).toBeNull();
  });

  it('detects content tampering: recomputed hash diverges from the sealed digest', async () => {
    const { publicId, finalize } = await finalizeFresh();

    // The trigger freezes FINAL rows, bypass it to simulate an attacker
    // with direct database access, exactly the case verification covers.
    await h().db.query(`ALTER TABLE agreement_versions DISABLE TRIGGER agreement_versions_immutable`);
    try {
      await h().db.query(
        `UPDATE agreement_versions
         SET content = (content || '{"title":"TAMPERED"}'::jsonb)
         WHERE id = $1`,
        [finalize.versionId],
      );
    } finally {
      await h().db.query(`ALTER TABLE agreement_versions ENABLE TRIGGER agreement_versions_immutable`);
    }

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
    expect(res.json().integrity).toBe('MISMATCH');
    expect(res.json().recordState).toBe('MODIFIED');
    expect(res.json().recordMessage).toMatch(/modified|tamper|integrity/i);
    // Hash prefix still shows the originally sealed digest.
    expect(res.json().hashPrefix).toBe(finalize.documentHash.slice(0, 12));

    // The mismatch is persisted as a verification record.
    const { rows } = await h().db.query<{ result: string }>(
      `SELECT result FROM verification_records WHERE result = 'MISMATCH'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('records DOCUMENT_VERIFIED audit events for each check', async () => {
    const { publicId, agreementId } = await finalizeFresh();

    await get(h(), `/api/v1/verification/${publicId}`);
    await get(h(), `/api/v1/verification/${publicId}`);

    const audit = await get(
      h(),
      `/api/v1/agreements/${agreementId}/audit`,
      (await registerUser(h(), undefined)).token,
    );
    // Stranger sees nothing…
    expect(audit.statusCode).toBe(404);

    const { rows } = await h().db.query<{ event_type: string; metadata: { result: string } }>(
      `SELECT event_type, metadata FROM audit_events
       WHERE agreement_id = $1 AND event_type = 'DOCUMENT_VERIFIED'
       ORDER BY seq`,
      [agreementId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.metadata.result).toBe('VERIFIED');
  });

  it('every verification check appends an immutable verification record', async () => {
    const { publicId } = await finalizeFresh();
    await get(h(), `/api/v1/verification/${publicId}`);

    const { rows } = await h().db.query<{ id: string }>(`SELECT id FROM verification_records`);
    // 1 initial SYSTEM record at finalization + 1 URL check.
    expect(rows.length).toBeGreaterThanOrEqual(2);

    await expect(
      h().db.query(`DELETE FROM verification_records`),
    ).rejects.toThrow(/append-only/);
  });

  it('verification records never store the raw requester IP', async () => {
    const { publicId } = await finalizeFresh();
    await get(h(), `/api/v1/verification/${publicId}`);

    const { rows } = await h().db.query<{ requester_hash: string | null }>(
      `SELECT requester_hash FROM verification_records WHERE requester_hash IS NOT NULL`,
    );
    expect(rows).toHaveLength(1);
    // Hashed (sha256 of "verify:<ip>"), not a dotted-quad.
    expect(rows[0]?.requester_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.requester_hash).not.toContain('127.0.0.1');
  });

  it('reports intact evidence separately from an ended lifecycle (expired/terminated)', async () => {
    const { publicId, agreementId } = await finalizeFresh();
    await h().db.query(
      `UPDATE agreements SET status = 'EXPIRED', closed_reason = 'EXPIRED', closed_at = now() WHERE id = $1`,
      [agreementId],
    );

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.integrity).toBe('VERIFIED');
    expect(body.recordState).toBe('REVOKED');
    expect(body.status).toBe('EXPIRED');
    expect(body.lifecycleLabel).toBe('Expired');
    expect(body.recordMessage).toMatch(/not a claim.*currently in force|legal effect|lifecycle/i);
  });
});
