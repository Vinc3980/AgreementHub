/**
 * Document pipeline: HTML → PDF → hash → storage → verification.
 *
 * - Preview renders the canonical document, labelled DRAFT: NOT FINAL
 *   (drafts) or FINAL AGREEMENT (sealed), and requires access.
 * - Finalization generates the immutable final PDF inside the same
 *   transaction: bytes on disk, sha256 recorded against the version.
 * - Final PDF downloads serve the stored bytes, hash-verified, never
 *   regenerated; tampering is refused with DOCUMENT_HASH_MISMATCH.
 * - Storage stays private: no path or key ever appears in API responses.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  authHeaders,
  get,
  post,
  registerUser,
  setupAwaitingSignatures,
  testConfig,
  useTestApp,
} from './helpers.js';

const storageDir = join(tmpdir(), `ah-docs-${process.pid}-${Date.now()}`);
const h = useTestApp({ PDF_GENERATION: 'on', STORAGE_DIR: storageDir });

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

/** Sign with both parties and finalize, the final PDF must exist after. */
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
  if (fin.statusCode !== 200) {
    throw new Error(`finalize failed: ${fin.statusCode} ${fin.body}`);
  }
  return {
    ...setup,
    finalize: fin.json() as { pdfSha256: string | null; documentHash: string },
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function finalPdfRow(agreementId: string) {
  const { rows } = await h().db.query<{
    storage_key: string;
    sha256: string;
    byte_size: string;
    engine: string;
  }>(
    `SELECT g.storage_key, g.sha256, g.byte_size, g.engine
     FROM generated_documents g
     JOIN agreement_versions v ON v.id = g.version_id
     WHERE v.agreement_id = $1`,
    [agreementId],
  );
  return rows[0] ?? null;
}

describe('document preview & print', () => {
  it('labels a draft DRAFT: NOT FINAL with print-ready identity', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await get(
      h(),
      `/api/v1/agreements/${setup.agreementId}/documents/1/preview`,
      setup.owner.token,
    );
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(String(res.headers['content-disposition'])).toContain('inline');

    const html = res.body;
    expect(html).toContain('DRAFT: NOT FINAL');
    expect(html).not.toContain('FINAL AGREEMENT');
    expect(html).toContain(setup.publicId);
    expect(html).toContain('Version 1');
    expect(html).toContain('AgreementHub');
    expect(html).toContain('@page'); // printer-friendly A4 rules
    expect(html).toContain('@media print');
    expect(html).toContain('Signatures'); // signature page present

    // Previewing is an audited document access with its format recorded.
    const audit = await get(h(), `/api/v1/agreements/${setup.agreementId}/audit`, setup.owner.token);
    const previews = (audit.json().events as Array<{ eventType: string; metadata: { format?: string } }>)
      .filter((e) => e.eventType === 'DOCUMENT_DOWNLOADED')
      .map((e) => e.metadata.format);
    expect(previews).toContain('preview');
  });

  it('requires authentication and hides other users’ documents', async () => {
    const setup = await setupAwaitingSignatures(h());
    const url = `/api/v1/agreements/${setup.agreementId}/documents/1/preview`;

    const anonymous = await get(h(), url);
    expect(anonymous.statusCode).toBe(401);

    const stranger = await registerUser(h());
    const forbidden = await get(h(), url, stranger.token);
    expect(forbidden.statusCode).toBe(404);
  });

  it('labels a finalized document FINAL AGREEMENT with signature details', async () => {
    const { agreementId, publicId, owner, counterparty } = await finalizeFresh();
    const res = await get(
      h(),
      `/api/v1/agreements/${agreementId}/documents/1/preview`,
      owner.token,
    );
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('FINAL AGREEMENT');
    expect(html).not.toContain('DRAFT: NOT FINAL');
    // Signature information retained: both signers, method label, dates.
    expect(html).toContain(owner.email);
    expect(html).toContain(counterparty.email);
    expect(html).toContain('Session signature');
    expect(html).toContain('Provider');
    expect(html).toContain('Client');
    expect(html).toContain(publicId);
    expect(html).toContain('Document hash (SHA-256)');
  });
});

describe('PDF generation', () => {
  it('renders a draft PDF on demand without persisting anything', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await get(
      h(),
      `/api/v1/agreements/${setup.agreementId}/documents/1/pdf`,
      setup.owner.token,
    );
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/pdf');
    expect(String(res.headers['content-disposition'])).toContain(
      `filename="${setup.publicId}-v1.pdf"`,
    );
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(1_000);

    // Drafts are ephemeral: nothing was written to storage.
    const { rows } = await h().db.query(`SELECT id FROM generated_documents`);
    expect(rows).toHaveLength(0);

    const audit = await get(h(), `/api/v1/agreements/${setup.agreementId}/audit`, setup.owner.token);
    const pdfEvent = (audit.json().events as Array<{ eventType: string; metadata: { format?: string; source?: string } }>)
      .find((e) => e.eventType === 'DOCUMENT_DOWNLOADED' && e.metadata.format === 'pdf');
    expect(pdfEvent?.metadata.source).toBe('generated');
  });

  it('generates the immutable final PDF at finalization and records its hash', async () => {
    const { agreementId, owner, finalize } = await finalizeFresh();
    expect(finalize.pdfSha256).toMatch(/^[0-9a-f]{64}$/);

    const row = await finalPdfRow(agreementId);
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(finalize.pdfSha256);

    // The bytes on disk match the hash recorded against the final version.
    const abs = join(storageDir, row!.storage_key);
    const bytes = await readFile(abs);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sha256(bytes)).toBe(row!.sha256);
    expect(String(bytes.length)).toBe(row!.byte_size);

    // Generation is an audited (system) event carrying the PDF hash.
    const audit = await get(h(), `/api/v1/agreements/${agreementId}/audit`, owner.token);
    const generated = (audit.json().events as Array<{
      eventType: string;
      category: string;
      metadata: { sha256?: string };
    }>).find((e) => e.eventType === 'DOCUMENT_GENERATED');
    expect(generated).toBeTruthy();
    expect(generated!.category).toBe('SYSTEM');
    expect(generated!.metadata.sha256).toBe(finalize.pdfSha256);

    // Storage privacy: no path, key, or storage location leaks via the API.
    const detail = await get(h(), `/api/v1/agreements/${agreementId}`, owner.token);
    const versions = await get(h(), `/api/v1/agreements/${agreementId}/versions`, owner.token);
    for (const body of [detail.body, versions.body]) {
      expect(body).not.toContain(row!.storage_key);
      expect(body).not.toContain('storage_key');
      expect(body).not.toContain(storageDir.replace(/\\/g, '/'));
    }
  });

  it('serves the stored final PDF on every download without regenerating', async () => {
    const { agreementId, publicId, owner } = await finalizeFresh();
    const row = await finalPdfRow(agreementId);
    expect(row).not.toBeNull();
    const abs = join(storageDir, row!.storage_key);
    const originalBytes = await readFile(abs);

    const url = `/api/v1/agreements/${agreementId}/documents/1/pdf`;
    const first = await get(h(), url, owner.token);
    expect(first.statusCode).toBe(200);
    expect(sha256(first.rawPayload)).toBe(row!.sha256);
    expect(first.headers['x-document-sha256']).toBe(row!.sha256);
    expect(String(first.headers['content-disposition'])).toContain(
      `filename="${publicId}-v1.pdf"`,
    );

    const second = await get(h(), url, owner.token);
    expect(sha256(second.rawPayload)).toBe(row!.sha256);

    // The stored file and record were not rewritten by either download.
    expect(sha256(await readFile(abs))).toBe(sha256(originalBytes));
    const { rows } = await h().db.query(`SELECT id FROM generated_documents`);
    expect(rows).toHaveLength(1);
  });

  it('refuses to serve a stored PDF whose bytes no longer match the hash', async () => {
    const { agreementId, owner } = await finalizeFresh();
    const row = await finalPdfRow(agreementId);
    expect(row).not.toBeNull();
    const abs = join(storageDir, row!.storage_key);

    // Tamper with the stored file (simulates storage-level corruption).
    await writeFile(abs, Buffer.from('%PDF-tampered'));

    const res = await get(
      h(),
      `/api/v1/agreements/${agreementId}/documents/1/pdf`,
      owner.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DOCUMENT_HASH_MISMATCH');
    // Not served, not silently regenerated.
    expect(sha256(await readFile(abs))).toBe(sha256(Buffer.from('%PDF-tampered')));
  });

  it('backfills the final PDF once for versions finalized before the pipeline', async () => {
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

    // A pre-pipeline server: PDF generation disabled, finalizes without a PDF.
    const offApp = await buildApp({
      config: testConfig({ PDF_GENERATION: 'off', STORAGE_DIR: storageDir }),
      db: h().db,
    });
    try {
      const fin = await offApp.inject({
        method: 'POST',
        url: `/api/v1/agreements/${setup.agreementId}/finalize`,
        headers: authHeaders(setup.owner.token),
        payload: {},
      });
      expect(fin.statusCode).toBe(200);
      expect(fin.json().pdfSha256).toBeNull();
      const { rows } = await h().db.query(`SELECT id FROM generated_documents`);
      expect(rows).toHaveLength(0);
    } finally {
      await offApp.close();
    }

    // First download from the current server backfills storage exactly once…
    const url = `/api/v1/agreements/${setup.agreementId}/documents/1/pdf`;
    const first = await get(h(), url, setup.owner.token);
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const row = await finalPdfRow(setup.agreementId);
    expect(row).not.toBeNull();
    expect(sha256(first.rawPayload)).toBe(row!.sha256);

    // …and from then on the stored bytes are served unchanged.
    const second = await get(h(), url, setup.owner.token);
    expect(sha256(second.rawPayload)).toBe(row!.sha256);
  });

  it('answers 503 when PDF generation is disabled and no stored PDF exists', async () => {
    const setup = await setupAwaitingSignatures(h());
    const offApp = await buildApp({
      config: testConfig({ PDF_GENERATION: 'off', STORAGE_DIR: storageDir }),
      db: h().db,
    });
    try {
      const res = await offApp.inject({
        method: 'GET',
        url: `/api/v1/agreements/${setup.agreementId}/documents/1/pdf`,
        headers: authHeaders(setup.owner.token),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('PDF_UNAVAILABLE');
    } finally {
      await offApp.close();
    }
  });

  it('generated document records are immutable (DB trigger blocks UPDATE/DELETE)', async () => {
    const { agreementId } = await finalizeFresh();
    const row = await finalPdfRow(agreementId);
    expect(row).not.toBeNull();
    const { rows } = await h().db.query<{ id: string }>(
      `SELECT g.id FROM generated_documents g
       JOIN agreement_versions v ON v.id = g.version_id
       WHERE v.agreement_id = $1`,
      [agreementId],
    );
    const docId = rows[0]?.id;
    expect(docId).toBeTruthy();

    await expect(
      h().db.query(`UPDATE generated_documents SET sha256 = repeat('0', 64) WHERE id = $1`, [
        docId,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      h().db.query(`DELETE FROM generated_documents WHERE id = $1`, [docId]),
    ).rejects.toThrow(/immutable/);

    const { rows: after } = await h().db.query<{ sha256: string }>(
      `SELECT sha256 FROM generated_documents WHERE id = $1`,
      [docId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.sha256).toBe(row!.sha256);
  });
});
