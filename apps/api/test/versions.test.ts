/**
 * Versions: creation, supersession, diff, and immutability, both at the API
 * level and at the database trigger level (direct SQL tampering must fail).
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  firstTemplateId,
  get,
  patch,
  post,
  registerUser,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('version creation', () => {
  it('creates a new version that supersedes its predecessor', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      '/api/v1/versions',
      { agreementId: agreement.id, changeSummary: 'Initial commit of draft' },
      user.token,
    );
    expect(res.statusCode).toBe(201);
    const v2 = res.json().version;
    expect(v2.versionNumber).toBe(2);
    expect(v2.status).toBe('DRAFT');
    expect(v2.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v2.previousVersionId).toBe(initialVersion.id);
    // Identical working copy ⇒ identical content hash (content-addressed).
    expect(v2.documentHash).toBe(initialVersion.documentHash);

    const list = await get(h(), `/api/v1/agreements/${agreement.id}/versions`, user.token);
    expect(list.statusCode).toBe(200);
    const versions = list.json().versions as Array<{ id: string; status: string; versionNumber: number }>;
    expect(versions).toHaveLength(2);
    // Predecessor superseded; list view carries no document content.
    expect(versions.find((v) => v.id === initialVersion.id)?.status).toBe('SUPERSEDED');
    expect(versions.find((v) => v.id === v2.id)?.status).toBe('DRAFT');
    expect(Object.keys(versions[0] ?? {})).not.toContain('content');
  });

  it('rejects a missing changeSummary at validation level', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(h(), '/api/v1/versions', { agreementId: agreement.id }, user.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('refuses new versions once signatures are awaited', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);

    const res = await post(
      h(),
      '/api/v1/versions',
      { agreementId: agreement.id, changeSummary: 'too late' },
      user.token,
    );
    // REVIEW is still editable; the lock kicks in at AWAITING_SIGNATURES.
    expect([201, 409]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      await post(h(), '/api/v1/approvals/request', { agreementId: agreement.id }, user.token);
      await post(
        h(),
        '/api/v1/approvals',
        { agreementId: agreement.id, decision: 'APPROVED' },
        user.token,
      );
      const locked = await post(
        h(),
        '/api/v1/versions',
        { agreementId: agreement.id, changeSummary: 'locked?' },
        user.token,
      );
      expect(locked.statusCode).toBe(409);
      expect(locked.json().code).toBe('VERSION_LOCKED');
    }
  });

  it('diffs two versions and reports title/section changes', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    // Create version 2 first: version 1 is superseded and frozen from here on.
    const created = await post(
      h(),
      '/api/v1/versions',
      { agreementId: agreement.id, changeSummary: 'Baseline before edits' },
      user.token,
    );
    expect(created.statusCode).toBe(201);
    const v2 = created.json().version;

    // Edits now refresh the latest DRAFT (v2) in place; v1 stays frozen.
    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const firstSection = detail.json().sections[0] as { code: string; title: string };
    const edit = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      {
        title: 'Revised title',
        sections: [
          { code: firstSection.code, title: firstSection.title, body: 'New body', included: true },
        ],
      },
      user.token,
    );
    expect(edit.statusCode).toBe(200);

    const diff = await get(h(), `/api/v1/versions/${initialVersion.id}/diff/${v2.id}`, user.token);
    expect(diff.statusCode).toBe(200);
    const body = diff.json().diff;
    expect(body.fromVersion).toBe(1);
    expect(body.toVersion).toBe(2);
    expect(body.hashFrom).not.toBe(body.hashTo);
    expect(body.changes.some((c: { kind: string; code: string }) => c.kind === 'title')).toBe(true);
    expect(
      body.changes.some(
        (c: { kind: string; code: string; change: string }) =>
          c.kind === 'section' && c.code === firstSection.code && c.change === 'modified',
      ),
    ).toBe(true);
  });

  it('refuses diffs across agreements', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const a = await createAgreement(h(), user.token, templateId, 'A');
    const b = await createAgreement(h(), user.token, templateId, 'B');

    const res = await get(
      h(),
      `/api/v1/versions/${a.initialVersion.id}/diff/${b.initialVersion.id}`,
      user.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CROSS_AGREEMENT_DIFF');
  });
});

describe('version immutability', () => {
  it('freezes a committed version against further content edits (API level)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    // Commit version 1 into review (approval request), making it PENDING_APPROVAL.
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);
    const req = await post(h(), '/api/v1/approvals/request', { agreementId: agreement.id }, user.token);
    expect(req.statusCode).toBe(200);

    const { rows } = await h().db.query<{ status: string }>(
      `SELECT status FROM agreement_versions WHERE id = $1`,
      [initialVersion.id],
    );
    expect(rows[0]?.status).toBe('PENDING_APPROVAL');

    // Draft edits are rejected while the agreement is in REVIEW.
    const edit = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { title: 'sneaky edit' },
      user.token,
    );
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe('NOT_DRAFT');
  });

  it('blocks direct SQL UPDATE of a committed snapshot (DB trigger)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);
    await post(h(), '/api/v1/approvals/request', { agreementId: agreement.id }, user.token);

    await expect(
      h().db.query(`UPDATE agreement_versions SET content = '{}'::jsonb WHERE id = $1`, [
        initialVersion.id,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      h().db.query(`UPDATE agreement_versions SET document_hash = 'deadbeef' WHERE id = $1`, [
        initialVersion.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('blocks direct SQL UPDATE of version metadata for any version', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    // Even a DRAFT version cannot have its lineage/number rewritten.
    await expect(
      h().db.query(`UPDATE agreement_versions SET version_number = 99 WHERE id = $1`, [
        initialVersion.id,
      ]),
    ).rejects.toThrow(/metadata is immutable/);

    await expect(
      h().db.query(`UPDATE agreement_versions SET created_by = '00000000-0000-0000-0000-000000000000' WHERE id = $1`, [
        initialVersion.id,
      ]),
    ).rejects.toThrow(/metadata is immutable/);
  });

  it('blocks deletion of any version row (append-only)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    await expect(
      h().db.query(`DELETE FROM agreement_versions WHERE id = $1`, [initialVersion.id]),
    ).rejects.toThrow(/cannot be deleted/);

    const { rows } = await h().db.query(`SELECT id FROM agreement_versions WHERE id = $1`, [
      initialVersion.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('still allows editing the working DRAFT version in place', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const sec = detail.json().sections[0] as { code: string; title: string };
    const res = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { sections: [{ code: sec.code, title: sec.title, body: 'Draft body', included: true }] },
      user.token,
    );
    expect(res.statusCode).toBe(200);

    const { rows } = await h().db.query<{ content: { sections: Array<{ body: string }> } }>(
      `SELECT content FROM agreement_versions WHERE id = $1`,
      [initialVersion.id],
    );
    const stored = rows[0]?.content.sections.find((s) => s.body === 'Draft body');
    expect(stored).toBeTruthy();
  });
});
