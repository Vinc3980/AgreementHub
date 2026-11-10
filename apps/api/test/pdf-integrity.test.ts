/**
 * PDF / QR integrity verification (audit Phase 4).
 *
 * Content, PDF bytes and signature records are checked independently. The QR
 * link carries the registered PDF digest so a replaced PDF is detected even
 * when the agreement record itself is intact.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { get, post, setupAwaitingSignatures, useTestApp } from './helpers.js';

const storageDir = join(tmpdir(), `ah-pdf-verify-${process.pid}-${Date.now()}`);
const h = useTestApp({ PDF_GENERATION: 'on', STORAGE_DIR: storageDir });

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

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
  expect(fin.statusCode).toBe(200);
  const body = fin.json() as { pdfSha256: string | null; documentHash: string };
  expect(body.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
  return { ...setup, finalize: body, pdfHash: body.pdfSha256! };
}

async function storedPdf(agreementId: string) {
  const { rows } = await h().db.query<{ storage_key: string; sha256: string }>(
    `SELECT g.storage_key, g.sha256
       FROM generated_documents g
       JOIN agreement_versions v ON v.id = g.version_id
      WHERE v.agreement_id = $1`,
    [agreementId],
  );
  return rows[0]!;
}

describe('PDF integrity and QR hash checks', () => {
  it('verifies the stored PDF bytes and exposes the registered digest', async () => {
    const { publicId, pdfHash } = await finalizeFresh();
    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.integrity).toBe('VERIFIED');
    expect(body.contentIntegrity).toBe('VERIFIED');
    expect(body.pdfIntegrity).toBe('VERIFIED');
    expect(body.signatureIntegrity).toBe('VERIFIED');
    expect(body.pdfHash).toBe(pdfHash);
    expect(body.pdfHashPrefix).toBe(pdfHash.slice(0, 12));
    // Only digests and metadata, never contents or keys.
    expect(body).not.toHaveProperty('storageKey');
    expect(body).not.toHaveProperty('content');
  });

  it('accepts a matching QR pdfHash and flags a mismatching one', async () => {
    const { publicId, pdfHash } = await finalizeFresh();

    const good = await get(h(), `/api/v1/verification/${publicId}?pdfHash=${pdfHash}`);
    expect(good.statusCode).toBe(200);
    expect(good.json().pdfIntegrity).toBe('VERIFIED');
    expect(good.json().integrity).toBe('VERIFIED');

    const wrong = await get(h(), `/api/v1/verification/${publicId}?pdfHash=${'a'.repeat(64)}`);
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json().pdfIntegrity).toBe('MISMATCH');
    expect(wrong.json().integrity).toBe('MISMATCH');

    // Malformed digest is ignored rather than treated as a mismatch.
    const malformed = await get(h(), `/api/v1/verification/${publicId}?pdfHash=not-a-hash`);
    expect(malformed.json().pdfIntegrity).toBe('VERIFIED');
  });

  it('detects a replaced/tampered PDF file while the record is intact', async () => {
    const { publicId, agreementId } = await finalizeFresh();
    const stored = await storedPdf(agreementId);
    const path = join(storageDir, stored.storage_key);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('%TAMPERED')]));

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().contentIntegrity).toBe('VERIFIED');
    expect(res.json().signatureIntegrity).toBe('VERIFIED');
    expect(res.json().pdfIntegrity).toBe('MISMATCH');
    expect(res.json().integrity).toBe('MISMATCH');

    // The digest shown is the originally registered one.
    expect(res.json().pdfHash).toBe(stored.sha256);
  });

  it('detects a signature-record digest that no longer matches its snapshot', async () => {
    const { publicId, agreementId } = await finalizeFresh();

    await h().db.query(`ALTER TABLE signatures DISABLE TRIGGER signatures_immutable`);
    try {
      await h().db.query(
        `UPDATE signatures
            SET payload_snapshot = jsonb_set(payload_snapshot, '{consentTextVersion}', '"tampered"')
          WHERE agreement_id = $1
            AND id = (SELECT id FROM signatures WHERE agreement_id = $1 LIMIT 1)`,
        [agreementId],
      );
    } finally {
      await h().db.query(`ALTER TABLE signatures ENABLE TRIGGER signatures_immutable`);
    }

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().signatureIntegrity).toBe('MISMATCH');
    expect(res.json().integrity).toBe('MISMATCH');
    expect(res.json().signatures.verified).toBe(1);
  });

  it('reports UNVERIFIED (not a false pass) for legacy signatures without a snapshot', async () => {
    const { publicId, agreementId } = await finalizeFresh();

    await h().db.query(`ALTER TABLE signatures DISABLE TRIGGER signatures_immutable`);
    try {
      await h().db.query(
        `UPDATE signatures SET payload_snapshot = NULL WHERE agreement_id = $1`,
        [agreementId],
      );
    } finally {
      await h().db.query(`ALTER TABLE signatures ENABLE TRIGGER signatures_immutable`);
    }

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().signatureIntegrity).toBe('UNVERIFIED');
    expect(res.json().signatures.verified).toBe(0);
    // Legacy records are not treated as tampering.
    expect(res.json().integrity).toBe('VERIFIED');
  });

  it('records the three check results separately', async () => {
    const { publicId, agreementId } = await finalizeFresh();
    await get(h(), `/api/v1/verification/${publicId}`);

    const { rows } = await h().db.query<{
      content_result: string;
      pdf_result: string;
      signature_result: string;
      pdf_hash: string | null;
    }>(
      `SELECT content_result, pdf_result, signature_result, pdf_hash
         FROM verification_records
        WHERE agreement_id = $1 AND result = 'VERIFIED'
        ORDER BY checked_at DESC LIMIT 1`,
      [agreementId],
    );
    expect(rows[0]!.content_result).toBe('VERIFIED');
    expect(rows[0]!.pdf_result).toBe('VERIFIED');
    expect(rows[0]!.signature_result).toBe('VERIFIED');
    expect(rows[0]!.pdf_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the generated PDF checksum equals the digest shown by verification', async () => {
    const { publicId, agreementId, pdfHash } = await finalizeFresh();
    const stored = await storedPdf(agreementId);
    const bytes = await readFile(join(storageDir, stored.storage_key));
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(digest).toBe(pdfHash);

    const res = await get(h(), `/api/v1/verification/${publicId}`);
    expect(res.json().pdfHash).toBe(digest);
  });
});
