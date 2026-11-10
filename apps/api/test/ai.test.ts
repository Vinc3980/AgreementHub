/**
 * AI Agreement Assistant tests:
 *  - authentication on every /ai endpoint;
 *  - feature 1 extraction: generic slots without a template, mapping onto
 *    real template field codes with one, validation;
 *  - features 2-5: review/explain/summary/questions shape + fixed framing
 *    ("Potentially missing information", disclaimer, not-legal-advice);
 *  - READ-ONLY guarantee: no /ai endpoint alters an agreement, and a
 *    finalized agreement stays immutable while remaining explainer-friendly;
 *  - confirmation path: extracted suggestions are applied only through the
 *    normal PATCH with provenance AI_SUGGESTED_CONFIRMED;
 *  - access control (no cross-user reads through the assistant).
 */
import { describe, expect, it } from 'vitest';
import {
  AI_DISCLAIMER,
  AI_REVIEW_HEADING,
} from '@agreementhub/contracts';
import {
  createAgreement,
  firstTemplateId,
  get,
  patch,
  post,
  registerUser,
  setupAwaitingSignatures,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

const KOJO_DESCRIPTION =
  "I am building a restaurant website for Kojo's Kitchen. The project costs 8,000 cedis. " +
  'They will pay 50% before development and 50% when the website is launched. ' +
  'I will provide three revisions and two months of maintenance.';

/** Every AI response carries these, whatever the feature/provider. */
function expectBrief(body: Record<string, unknown>) {
  expect(body.disclaimer).toBe(AI_DISCLAIMER);
  expect(body.aiGenerated).toBe(true);
  expect(typeof body.provider).toBe('string');
  expect(typeof body.providerLabel).toBe('string');
}

async function freelanceTemplateId(): Promise<string> {
  const { rows } = await h().db.query<{ id: string }>(
    `SELECT t.id FROM agreement_templates t
       JOIN template_categories c ON c.id = t.category_id
      WHERE c.code = 'FREELANCE' AND t.status = 'PUBLISHED'
      ORDER BY t.template_version DESC LIMIT 1`,
  );
  if (!rows[0]) throw new Error('No published FREELANCE template');
  return rows[0].id;
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

describe('AI assistant auth', () => {
  it('rejects unauthenticated requests on every endpoint', async () => {
    const templateId = await firstTemplateId(h().db);
    const user = await registerUser(h());
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const endpoints: Array<[string, unknown]> = [
      ['/api/v1/ai/extract', { description: KOJO_DESCRIPTION }],
      [`/api/v1/agreements/${agreement.id}/ai/review`, {}],
      [`/api/v1/agreements/${agreement.id}/ai/explain`, { agreementId: agreement.id, text: 'The Client shall pay.' }],
      [`/api/v1/agreements/${agreement.id}/ai/summary`, {}],
      [`/api/v1/agreements/${agreement.id}/ai/questions`, {}],
    ];
    for (const [url, body] of endpoints) {
      const res = await h().app.inject({ method: 'POST', url, payload: body as object });
      expect(res.statusCode, `POST ${url}`).toBe(401);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Feature 1: plain language → fields                                  */
/* ------------------------------------------------------------------ */

describe('POST /ai/extract', () => {
  it('returns generic-slot suggestions with basis and needsInput (rules provider, no key)', async () => {
    const user = await registerUser(h());
    const res = await post(h(), '/api/v1/ai/extract', { description: KOJO_DESCRIPTION }, user.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    expect(body.provider).toBe('rules');
    expect(body.templateId).toBeNull();

    const codes = (body.fields as Array<{ fieldCode: string }>).map((f) => f.fieldCode);
    expect(codes).toContain('client');
    expect(codes).toContain('price');
    expect(codes).toContain('currency');
    expect(codes).toContain('payment_schedule');
    expect(codes).toContain('revision_limit');
    expect(codes).toContain('maintenance');

    const client = (body.fields as Array<{ fieldCode: string; value: string }>).find(
      (f) => f.fieldCode === 'client',
    );
    expect(client?.value).toContain('Kojo');
    const price = (body.fields as Array<{ fieldCode: string; value: string }>).find(
      (f) => f.fieldCode === 'price',
    );
    expect(price?.value).toBe('8000');
    expect(Array.isArray(body.needsInput)).toBe(true);
  });

  it('maps suggestions onto real template field codes when a template is given', async () => {
    const user = await registerUser(h());
    const templateId = await freelanceTemplateId();
    const res = await post(
      h(),
      '/api/v1/ai/extract',
      { description: KOJO_DESCRIPTION, templateId },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    expect(body.templateId).toBe(templateId);

    // Every suggested code must exist on the template, never phantom fields.
    const { rows } = await h().db.query<{ content_schema: unknown }>(
      `SELECT content_schema FROM agreement_templates WHERE id = $1`,
      [templateId],
    );
    const rawSchema = rows[0]!.content_schema;
    const definition = (
      typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema
    ) as {
      fields: Array<{ code: string }>;
    };
    const known = new Set(definition.fields.map((f) => f.code));
    for (const f of body.fields as Array<{ fieldCode: string }>) {
      expect(known.has(f.fieldCode), `unknown field code ${f.fieldCode}`).toBe(true);
    }
    const fields = body.fields as Array<{ fieldCode: string; value: string }>;
    const codes = fields.map((f) => f.fieldCode);
    expect(codes).toContain('client_name');
    expect(codes).toContain('project_fee');
    expect(codes).toContain('revision_limit');
    // "8,000 cedis" is detected as GHS and accepted on v2 templates that offer it.
    const currency = fields.find((f) => f.fieldCode === 'currency');
    expect(currency?.value).toBe('GHS');
  });

  it('validates the description', async () => {
    const user = await registerUser(h());
    const short = await post(h(), '/api/v1/ai/extract', { description: 'tiny' }, user.token);
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe('VALIDATION_FAILED');

    const missing = await post(h(), '/api/v1/ai/extract', {}, user.token);
    expect(missing.statusCode).toBe(400);
  });

  it('404s for an unknown template', async () => {
    const user = await registerUser(h());
    const res = await post(
      h(),
      '/api/v1/ai/extract',
      { description: KOJO_DESCRIPTION, templateId: '00000000-0000-4000-8000-000000000000' },
      user.token,
    );
    expect(res.statusCode).toBe(404);
  });

  it('never writes anything (extract alone leaves no trace on agreements)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const before = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const beforeVersion = (before.json() as { currentVersion: { id: string } }).currentVersion.id;

    await post(
      h(),
      '/api/v1/ai/extract',
      { description: KOJO_DESCRIPTION, templateId },
      user.token,
    );

    const after = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    expect((after.json() as { currentVersion: { id: string } }).currentVersion.id).toBe(beforeVersion);
    expect(after.body).toBe(before.body);
  });
});

/* ------------------------------------------------------------------ */
/* Feature 2: review                                                   */
/* ------------------------------------------------------------------ */

describe('POST /agreements/:id/ai/review', () => {
  it('lists potentially missing information for an unfilled draft', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    // Raw create: required fields deliberately left blank so gaps exist.
    const created = await post(h(), '/api/v1/agreements', { templateId, title: 'Gappy draft' }, user.token);
    expect(created.statusCode).toBe(201);
    const agreementId = (created.json() as { agreement: { id: string } }).agreement.id;

    const res = await post(h(), `/api/v1/agreements/${agreementId}/ai/review`, {}, user.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    expect(body.heading).toBe(AI_REVIEW_HEADING);
    expect(body.heading).toBe('Potentially missing information');

    const items = body.items as Array<{ label: string; detail: string; severity: string }>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(['important', 'worth-considering']).toContain(item.severity);
      // Never a legal verdict, ever.
      const text = `${item.label} ${item.detail}`.toLowerCase();
      expect(text).not.toMatch(/illegal|unenforceable|not valid|invalid contract/);
    }
    // Blank required fields are flagged as important.
    expect(items.some((i) => i.severity === 'important')).toBe(true);
  });

  it('agrees with a filled draft being mostly clean', async () => {
    const user = await registerUser(h());
    const templateId = await freelanceTemplateId();
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const res = await post(h(), `/api/v1/agreements/${agreement.id}/ai/review`, {}, user.token);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ severity: string; fieldCode: string | null }>;
    // Required fields are all filled → no blank-field "important" items.
    // (Topic-level "important" flags like cancellation are legitimate
    // suggestions on any draft; blank required fields are not.)
    expect(items.filter((i) => i.severity === 'important' && i.fieldCode !== null)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Feature 3: explain                                                  */
/* ------------------------------------------------------------------ */

describe('POST /agreements/:id/ai/explain', () => {
  it('explains raw text in plain language with a phrase breakdown', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/ai/explain`,
      { agreementId: agreement.id, text: 'The Client shall indemnify the Supplier against any liability.' },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    expect(body.notLegalAdvice).toBe(true);
    expect(body.formalText).toContain('indemnify');
    expect(String(body.plainLanguage).length).toBeGreaterThan(10);
    expect(Array.isArray(body.phrases)).toBe(true);
    // Must not claim legality/enforceability.
    const blob = JSON.stringify(body).toLowerCase();
    expect(blob).not.toMatch(/legally enforceable|is enforceable|legally valid/);
  });

  it('explains a stored section by code (body fetched server-side)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const sections = (detail.json() as { sections: Array<{ code: string; body: string }> }).sections;
    expect(sections.length).toBeGreaterThan(0);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/ai/explain`,
      { agreementId: agreement.id, sectionCode: sections[0]!.code },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    expect(body.formalText).toBe(sections[0]!.body);
    expect(body.notLegalAdvice).toBe(true);
  });

  it('rejects agreementId mismatch and empty input', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const mismatch = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/ai/explain`,
      { agreementId: '00000000-0000-4000-8000-000000000000', text: 'Some clause.' },
      user.token,
    );
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe('AGREEMENT_MISMATCH');

    const empty = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/ai/explain`,
      { agreementId: agreement.id },
      user.token,
    );
    expect(empty.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Feature 4: summary                                                  */
/* ------------------------------------------------------------------ */

describe('POST /agreements/:id/ai/summary', () => {
  it('returns all summary sections with the disclaimer', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(h(), `/api/v1/agreements/${agreement.id}/ai/summary`, {}, user.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    for (const key of ['parties', 'purpose', 'payment', 'timeline', 'responsibilities', 'termination']) {
      expect(typeof body[key], key).toBe('string');
      expect(String(body[key]).length).toBeGreaterThan(0);
    }
    expect(Array.isArray(body.importantDates)).toBe(true);
    // A summary must not assert validity.
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/legally binding guarantee|enforceable/);
  });
});

/* ------------------------------------------------------------------ */
/* Feature 5: suggested questions                                      */
/* ------------------------------------------------------------------ */

describe('POST /agreements/:id/ai/questions', () => {
  it('suggests neutral drafting questions the user may add', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(h(), `/api/v1/agreements/${agreement.id}/ai/questions`, {}, user.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBrief(body);
    const questions = body.questions as Array<{ text: string; fieldCode: string | null }>;
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.text.endsWith('?'), `question must be phrased as a question: ${q.text}`).toBe(true);
      expect(q.text.toLowerCase()).not.toMatch(/illegal|unenforceable/);
    }
  });

  it('does not modify the agreement (read-only feature)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const before = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);

    await post(h(), `/api/v1/agreements/${agreement.id}/ai/review`, {}, user.token);
    await post(h(), `/api/v1/agreements/${agreement.id}/ai/summary`, {}, user.token);
    await post(h(), `/api/v1/agreements/${agreement.id}/ai/questions`, {}, user.token);
    await post(
      h(),
      `/api/v1/agreements/${agreement.id}/ai/explain`,
      { agreementId: agreement.id, text: 'The Client shall pay the Fee.' },
      user.token,
    );

    const after = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    expect(after.body).toBe(before.body);
  });
});

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */

describe('AI assistant access control', () => {
  it('hides agreements from uninvited users (no IDOR via the assistant)', async () => {
    const owner = await registerUser(h());
    const stranger = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    for (const feature of ['review', 'summary', 'questions']) {
      const res = await post(h(), `/api/v1/agreements/${agreement.id}/ai/${feature}`, {}, stranger.token);
      expect(res.statusCode, feature).toBe(404);
    }
    const explain = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/ai/explain`,
      { agreementId: agreement.id, text: 'Clause text.' },
      stranger.token,
    );
    expect(explain.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Confirmation + finalization safety                                  */
/* ------------------------------------------------------------------ */

describe('AI confirmation and finalized agreements', () => {
  it('applies an extracted suggestion only via user PATCH (provenance AI_SUGGESTED_CONFIRMED)', async () => {
    const user = await registerUser(h());
    const templateId = await freelanceTemplateId();
    const { agreement } = await createAgreement(h(), user.token, templateId);

    // Extract → suggestion (server wrote nothing).
    const extracted = await post(
      h(),
      '/api/v1/ai/extract',
      { description: KOJO_DESCRIPTION, templateId },
      user.token,
    );
    expect(extracted.statusCode).toBe(200);
    const extractedFields = (extracted.json() as {
      fields: Array<{ fieldCode: string; value: string }>;
    }).fields;
    const suggestion = extractedFields.find((f) => f.fieldCode === 'client_name');
    expect(suggestion).toBeDefined();
    // A cedi amount is suggested and accepted for GHS-offering templates.
    expect(extractedFields.find((f) => f.fieldCode === 'currency')?.value).toBe('GHS');
    expect(extractedFields.find((f) => f.fieldCode === 'project_fee')?.value).toBe('8000');

    // User confirms → normal PATCH with AI provenance.
    const applied = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { fields: [{ code: 'client_name', value: suggestion!.value, provenance: 'AI_SUGGESTED_CONFIRMED' }] },
      user.token,
    );
    expect(applied.statusCode).toBe(200);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const field = (detail.json() as {
      fields: Array<{ code: string; value: unknown; provenance: string }>;
    }).fields.find((f) => f.code === 'client_name');
    expect(field?.value).toBe(suggestion!.value);
    expect(field?.provenance).toBe('AI_SUGGESTED_CONFIRMED');
  });

  it('keeps finalized agreements explainer-friendly but immutable', async () => {
    const setup = await setupAwaitingSignatures(h());
    // Both parties sign, then finalize (mirrors signatures.test.ts flow).
    await post(h(), '/api/v1/signatures', { agreementId: setup.agreementId, consent: true, method: 'SESSION' }, setup.owner.token);
    await post(h(), '/api/v1/signatures', { agreementId: setup.agreementId, consent: true, method: 'SESSION' }, setup.counterparty.token);
    const fin = await post(h(), `/api/v1/agreements/${setup.agreementId}/finalize`, {}, setup.owner.token);
    expect(fin.statusCode).toBe(200);

    // Read-only assistant features still work on a finalized agreement…
    for (const feature of ['review', 'summary', 'questions']) {
      const res = await post(h(), `/api/v1/agreements/${setup.agreementId}/ai/${feature}`, {}, setup.owner.token);
      expect(res.statusCode, feature).toBe(200);
      expectBrief(res.json());
    }
    const explain = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/ai/explain`,
      { agreementId: setup.agreementId, text: 'The Client shall pay the Fee.' },
      setup.owner.token,
    );
    expect(explain.statusCode).toBe(200);

    // …but no field write gets through, AI-confirmed or otherwise.
    const attempt = await patch(
      h(),
      `/api/v1/agreements/${setup.agreementId}`,
      { fields: [{ code: 'client_name', value: 'Sneaky Corp', provenance: 'AI_SUGGESTED_CONFIRMED' }] },
      setup.owner.token,
    );
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json().code).toBe('NOT_DRAFT');
  });
});
