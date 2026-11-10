/**
 * Agreement creation and access: public ID allocation, seeded sections,
 * initial version snapshot, list visibility.
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

describe('agreement creation', () => {
  it('creates an agreement with a well-formed public ID, seeded sections and version 1', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId, 'Website build');

    expect(agreement.publicId).toMatch(/^AGR-GH-\d{4}-\d{6}$/);
    expect(agreement.status).toBe('DRAFT');
    expect(initialVersion.versionNumber).toBe(1);
    expect(initialVersion.documentHash).toMatch(/^[0-9a-f]{64}$/);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.agreement.publicId).toBe(agreement.publicId);
    expect(body.sections.length).toBeGreaterThan(0);
    // Version 1 content mirrors the seeded template sections.
    expect(body.currentVersion.content.sections.length).toBe(body.sections.length);
    // Creator appears as OWNER party.
    expect(body.parties.some((p: { role: string }) => p.role === 'OWNER')).toBe(true);
  });

  it('allocates sequential, unique public IDs from the per-year counter', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const a = await createAgreement(h(), user.token, templateId, 'First');
    const b = await createAgreement(h(), user.token, templateId, 'Second');

    const year = new Date().getUTCFullYear();
    expect(a.agreement.publicId).toMatch(new RegExp(`^AGR-GH-${year}-\\d{6}$`));
    const seqA = Number(a.agreement.publicId.split('-')[3]);
    const seqB = Number(b.agreement.publicId.split('-')[3]);
    expect(seqB).toBe(seqA + 1);
    expect(b.agreement.publicId).not.toBe(a.agreement.publicId);
  });

  it('rejects an unknown or unpublished template with 404', async () => {
    const user = await registerUser(h());
    const res = await post(
      h(),
      '/api/v1/agreements',
      { templateId: '00000000-0000-0000-0000-000000000000', title: 'x' },
      user.token,
    );
    expect(res.statusCode).toBe(404);
  });

  it('validates the request body (missing title ⇒ 400)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const res = await post(h(), '/api/v1/agreements', { templateId }, user.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('records the creation in the audit chain', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const audit = await get(h(), `/api/v1/agreements/${agreement.id}/audit`, user.token);
    expect(audit.statusCode).toBe(200);
    const events = audit.json().events as Array<{
      eventType: string;
      seq: number;
      eventHash: string;
      actorLabel: string;
    }>;
    expect(events[0]?.eventType).toBe('AGREEMENT_CREATED');
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]?.actorLabel).toBe(user.email);
  });
});

describe('agreement access & draft updates', () => {
  it('lets the owner update the draft and refreshes the working version hash', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const firstSection = detail.json().sections[0] as { code: string; title: string };

    const res = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      {
        title: 'Renamed draft',
        sections: [
          { code: firstSection.code, title: firstSection.title, body: 'Edited body text.', included: true },
        ],
        fields: [{ code: 'fee_amount', value: '5000 USD', provenance: 'USER_PROVIDED' }],
      },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agreement.title).toBe('Renamed draft');
    expect(
      body.sections.find((s: { code: string }) => s.code === firstSection.code).body,
    ).toBe('Edited body text.');
    expect(body.fields.find((f: { code: string }) => f.code === 'fee_amount').value).toBe('5000 USD');
    // Draft version snapshot follows the working copy: hash must have changed.
    expect(body.currentVersion.documentHash).not.toBe(initialVersion.documentHash);
  });

  it('lists only agreements the caller can see', async () => {
    const alice = await registerUser(h());
    const bob = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    await createAgreement(h(), alice.token, templateId, 'Alice doc');

    const aliceList = await get(h(), '/api/v1/agreements', alice.token);
    expect(aliceList.json().agreements).toHaveLength(1);

    const bobList = await get(h(), '/api/v1/agreements', bob.token);
    expect(bobList.json().agreements).toHaveLength(0);
  });

  it('filters the list by status', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);

    const drafts = await get(h(), '/api/v1/agreements?status=DRAFT', user.token);
    expect(drafts.json().agreements).toHaveLength(0);
    const review = await get(h(), '/api/v1/agreements?status=REVIEW', user.token);
    expect(review.json().agreements).toHaveLength(1);
  });

  it('rejects draft edits once the agreement left DRAFT', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);

    const res = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { title: 'Too late' },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_DRAFT');
  });
});
