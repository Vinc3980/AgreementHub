/**
 * Template Engine tests:
 *  - seed integrity: all five initial templates parse, have no broken
 *    condition/placeholder references, and cover the required field sets;
 *  - conditional evaluation, document generation, and value validation;
 *  - MISSING_REQUIRED_FIELDS gates on approval requests and the transition
 *    into signing (defense-in-depth: finalize calls the same assertion).
 */
import { describe, expect, it } from 'vitest';
import {
  emptyValues,
  findDefinitionProblems,
  findMissingRequired,
  interpolate,
  parseTemplateDefinition,
  renderSections,
  validateValues,
  visibleSections,
} from '@agreementhub/domain/template';
import { assertTemplateComplete } from '../src/services/templateEngine.js';
import {
  createAgreement,
  fillRequiredFields,
  firstTemplateId,
  get,
  patch,
  post,
  registerUser,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

const CATEGORY_CODES = ['FREELANCE', 'RENTAL', 'PROPOSAL', 'NDA', 'CLIENT'] as const;

async function publishedTemplateFor(categoryCode: string, version?: 'latest' | 'v1') {
  const order = version === 'v1' ? 'ASC' : 'DESC';
  const { rows } = await h().db.query<{ id: string; content_schema: unknown; name: string }>(
    `SELECT t.id, t.content_schema, t.name
       FROM agreement_templates t
       JOIN template_categories c ON c.id = t.category_id
      WHERE c.code = $1 AND t.status = 'PUBLISHED'
      ORDER BY t.template_version ${order} LIMIT 1`,
    [categoryCode],
  );
  if (!rows[0]) throw new Error(`No published template for ${categoryCode}`);
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* Seed integrity                                                      */
/* ------------------------------------------------------------------ */

describe('initial template seeds', () => {
  it('publishes templates per category with valid, fully-linked definitions (all published versions)', async () => {
    const { rows } = await h().db.query<{ code: string; content_schema: unknown; template_version: number }>(
      `SELECT c.code, t.content_schema, t.template_version
         FROM agreement_templates t
         JOIN template_categories c ON c.id = t.category_id
        WHERE t.status = 'PUBLISHED'
        ORDER BY c.code, t.template_version`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(CATEGORY_CODES.length);
    const byCat = new Map<string, number>();
    for (const row of rows) {
      byCat.set(row.code, (byCat.get(row.code) ?? 0) + 1);
      const definition = parseTemplateDefinition(row.content_schema);
      expect(definition, `${row.code} v${row.template_version} must parse`).not.toBeNull();
      const problems = findDefinitionProblems(definition!);
      expect(problems, `${row.code} v${row.template_version}: ${problems.join(' | ')}`).toEqual([]);
      expect(definition!.sections.length).toBeGreaterThan(0);
      expect(definition!.fields.length).toBeGreaterThan(0);
    }
    for (const code of CATEGORY_CODES) expect(byCat.has(code), `${code} must be published`).toBe(true);
  });

  it('covers the required field sets of the five initial templates', async () => {
    const expectedFields: Record<string, string[]> = {
      FREELANCE: [
        'provider_name', 'client_name', 'service_description', 'project_scope',
        'deliverables', 'project_fee', 'currency', 'payment_schedule', 'start_date',
        'delivery_date', 'revision_limit', 'maintenance', 'cancellation',
        'confidentiality', 'intellectual_property', 'dispute_handling',
        'communication_method',
      ],
      RENTAL: [
        'landlord_name', 'tenant_name', 'property_description', 'rental_start',
        'rental_end', 'rent_amount', 'deposit_required', 'responsibilities',
        'maintenance_required', 'termination_notice', 'handover_notes',
      ],
      NDA: [
        'disclosing_party', 'receiving_party', 'confidential_information',
        'permitted_use', 'exclusions', 'duration_years', 'return_destruction',
        'general_obligations',
      ],
      CLIENT: [
        'provider_name', 'user_name', 'service_description', 'user_responsibilities',
        'provider_responsibilities', 'fee_amount', 'payment_terms', 'acceptable_use',
        'data_privacy_reference', 'termination', 'support_terms', 'general_terms',
      ],
    };
    for (const [code, requiredFieldCodes] of Object.entries(expectedFields)) {
      const template = await publishedTemplateFor(code);
      const definition = parseTemplateDefinition(template.content_schema)!;
      const fieldCodes = definition.fields.map((f) => f.code);
      for (const wanted of requiredFieldCodes) {
        expect(fieldCodes, `${code} must define field ${wanted}`).toContain(wanted);
      }
    }
  });

  it('the proposal template provides the eleven requested sections', async () => {
    const template = await publishedTemplateFor('PROPOSAL');
    const definition = parseTemplateDefinition(template.content_schema)!;
    const titles = definition.sections.map((s) => s.title);
    for (const wanted of [
      'Executive Summary', 'Client Problem', 'Proposed Solution', 'Deliverables',
      'Timeline', 'Pricing', 'Payment Schedule', 'Assumptions', 'Responsibilities',
      'Next Steps', 'Acceptance',
    ]) {
      expect(titles).toContain(wanted);
    }
  });

  it('defines conditional sections and required/optional/guided fields', async () => {
    const rental = parseTemplateDefinition((await publishedTemplateFor('RENTAL')).content_schema)!;
    const depositSection = rental.sections.find((s) => s.code === 'deposit')!;
    expect(depositSection.showIf).toEqual({ field: 'deposit_required', equals: 'Yes' });
    const maintenanceSection = rental.sections.find((s) => s.code === 'maintenance')!;
    expect(maintenanceSection.showIf).toEqual({ field: 'maintenance_required', equals: 'Yes' });

    expect(rental.fields.some((f) => f.required)).toBe(true);
    expect(rental.fields.some((f) => !f.required)).toBe(true);
    expect(rental.fields.some((f) => (f.guidance ?? '').length > 0)).toBe(true);

    const freelance = parseTemplateDefinition((await publishedTemplateFor('FREELANCE')).content_schema)!;
    expect(freelance.fields.find((f) => f.code === 'custom_schedule')!.showIf).toEqual({
      field: 'payment_schedule',
      equals: 'Custom',
    });
  });
});

/* ------------------------------------------------------------------ */
/* Pure evaluation                                                     */
/* ------------------------------------------------------------------ */

describe('template evaluation (pure)', () => {
  const definition = parseTemplateDefinition({
    sections: [
      { code: 'base', title: 'Base', order: 1, body: 'Hello {{field:name}}, fee {{field:fee}}.' },
      {
        code: 'extra', title: 'Extra', order: 2,
        showIf: { field: 'want_extra', equals: 'Yes' },
        body: 'Extra: {{field:extra_text}}',
      },
    ],
    fields: [
      { code: 'name', label: 'Name', type: 'text', required: true },
      { code: 'fee', label: 'Fee', type: 'money', required: true },
      {
        code: 'want_extra', label: 'Want extra?', type: 'select', required: true,
        options: ['No', 'Yes'], default: 'No',
      },
      {
        code: 'extra_text', label: 'Extra text', type: 'textarea', required: true,
        showIf: { field: 'want_extra', equals: 'Yes' },
      },
    ],
  })!;

  it('reports only visible required fields as missing', () => {
    const values = emptyValues(definition);
    expect(findMissingRequired(definition, values).map((m) => m.code)).toEqual(['name', 'fee']);
    // Hidden conditional required field must NOT block.
    expect(findMissingRequired(definition, values).map((m) => m.code)).not.toContain('extra_text');
    expect(
      findMissingRequired(definition, { ...values, want_extra: 'Yes' }).map((m) => m.code),
    ).toContain('extra_text');
  });

  it('reveals conditional sections when the condition matches', () => {
    expect(visibleSections(definition, emptyValues(definition)).map((s) => s.code)).toEqual(['base']);
    expect(visibleSections(definition, { ...emptyValues(definition), want_extra: 'Yes' })).toHaveLength(2);
  });

  it('validates formats and marks issues by kind', () => {
    const values = { ...emptyValues(definition), name: 'Ada', fee: 'abc' };
    const issues = validateValues(definition, values);
    expect(issues.find((i) => i.code === 'fee')).toMatchObject({ kind: 'format' });
    expect(issues.find((i) => i.code === 'name')).toBeUndefined();
    const requiredIssue = validateValues(definition, { ...emptyValues(definition), name: '' });
    expect(requiredIssue.find((i) => i.code === 'name')).toMatchObject({ kind: 'required' });
  });

  it('interpolates placeholders with blanks and toggles rendered plainly', () => {
    const rendered = renderSections(definition, { name: 'Ada', fee: 1000 })[0];
    // Money without a resolvable currency renders as a grouped amount (no code guess).
    expect(rendered?.body).toBe('Hello Ada, fee 1,000.00.');
    const blank = interpolate('Hi {{field:name}}', definition, {});
    expect(blank).toBe('Hi ________');
    // Hidden section still renders (visibility is reported separately).
    const hidden = renderSections(definition, emptyValues(definition))[1];
    expect(hidden?.visible).toBe(false);
  });

  it('renders money with currency code and amount-in-words when currency is resolvable', () => {
    const moneyDef = parseTemplateDefinition({
      sections: [{ code: 'pay', title: 'Pay', order: 1, body: 'Pay {{field:amount}}.' }],
      fields: [
        { code: 'amount', label: 'Amount', type: 'money', required: true, group: 'Payment' },
        { code: 'currency', label: 'Currency', type: 'select', required: true, group: 'Payment', options: ['GHS', 'USD'], default: 'GHS' },
      ],
    })!;
    const rendered = renderSections(moneyDef, { amount: '3500', currency: 'GHS' })[0];
    expect(rendered?.body).toBe('Pay GHS 3,500.00 (Three Thousand Five Hundred Ghana Cedis).');
  });

  it('flags definitions with unknown references', () => {
    const problems = findDefinitionProblems({
      sections: [{ code: 'broken', title: 'Broken', body: '{{field:nope}}' }],
      fields: [{ code: 'name', label: 'Name', type: 'text' }],
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end engine: creation, preview, generation                    */
/* ------------------------------------------------------------------ */

describe('template engine (agreement flows)', () => {
  it('creates drafts with composed sections, no placeholders, conditionals excluded', async () => {
    const user = await registerUser(h());
    const template = await publishedTemplateFor('FREELANCE');
    const { agreement } = await createAgreement(h(), user.token, template.id);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const body = detail.json();
    for (const section of body.sections as Array<{ code: string; body: string; included: boolean }>) {
      expect(section.body, `section ${section.code} must not contain placeholders`).not.toContain('{{');
      if (section.code === 'maintenance' || section.code === 'custom_payment') {
        expect(section.included).toBe(false); // defaults: maintenance No, schedule Per milestone
      }
    }
    // Required fields were answered (helper), the gate passes.
    await expect(
      assertTemplateComplete(h().db, agreement.id),
    ).resolves.toBeUndefined();
  });

  it('previews with unsaved overlay values without persisting them', async () => {
    const user = await registerUser(h());
    const template = await publishedTemplateFor('FREELANCE');
    const { agreement } = await createAgreement(h(), user.token, template.id);

    const preview = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/preview`,
      { values: { maintenance: 'Yes' } },
      user.token,
    );
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as {
      sections: Array<{ code: string; visible: boolean }>;
      fields: Array<{ code: string }>;
      missingRequired: Array<{ code: string }>;
    };
    expect(previewBody.sections.find((s) => s.code === 'maintenance')!.visible).toBe(true);
    expect(previewBody.fields.map((f) => f.code)).toContain('maintenance_terms');
    expect(previewBody.missingRequired.map((m) => m.code)).toContain('maintenance_terms');

    // Overlay was NOT persisted.
    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const maintenance = (detail.json().fields as Array<{ code: string; value: unknown }>)
      .find((f) => f.code === 'maintenance');
    expect(maintenance?.value).toBe('No');
  });

  it('generates the document: persists values, resolves conditions, composes bodies', async () => {
    const user = await registerUser(h());
    const template = await publishedTemplateFor('FREELANCE');
    const { agreement } = await createAgreement(h(), user.token, template.id);

    const generated = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/generate`,
      {
        values: {
          maintenance: 'Yes',
          maintenance_terms: 'Cover fixes and updates for six months after delivery.',
          payment_schedule: 'Custom',
          custom_schedule: '50% on signing, 50% on final delivery.',
        },
      },
      user.token,
    );
    expect(generated.statusCode).toBe(200);
    const genBody = generated.json() as {
      persisted: boolean;
      sections: Array<{ code: string; body: string; visible: boolean }>;
      missingRequired: Array<{ code: string }>;
    };
    expect(genBody.persisted).toBe(true);
    expect(genBody.missingRequired).toEqual([]);

    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const sections = detail.json().sections as Array<{
      code: string; body: string; included: boolean;
    }>;
    const maintenance = sections.find((s) => s.code === 'maintenance')!;
    expect(maintenance.included).toBe(true);
    expect(maintenance.body).toContain('Cover fixes and updates for six months');
    expect(maintenance.body).not.toContain('{{');
    const customPayment = sections.find((s) => s.code === 'custom_payment')!;
    expect(customPayment.included).toBe(true);
    expect(customPayment.body).toContain('50% on signing');
    // The deposit section stays excluded (deposit default = No).
    expect(sections.find((s) => s.code === 'deposit')).toBeUndefined(); // freelance has none
  });

  it('rejects generated values of the wrong type', async () => {
    const user = await registerUser(h());
    const template = await publishedTemplateFor('FREELANCE');
    const { agreement } = await createAgreement(h(), user.token, template.id);

    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/generate`,
      { values: { project_fee: 'lots of money' } },
      user.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('TEMPLATE_VALUES_INVALID');
    expect((res.json().errors as Record<string, string[]>).project_fee).toBeTruthy();
  });

  it('refuses generation once the agreement left DRAFT/NEGOTIATION', async () => {
    const user = await registerUser(h());
    const template = await publishedTemplateFor('FREELANCE');
    const { agreement } = await createAgreement(h(), user.token, template.id);
    // DRAFT → REVIEW → AWAITING_SIGNATURES (required fields are complete).
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);
    const res = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/generate`,
      {},
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_DRAFT');
  });
});

/* ------------------------------------------------------------------ */
/* Finalization gates                                                  */
/* ------------------------------------------------------------------ */

describe('MISSING_REQUIRED_FIELDS gates', () => {
  it('blocks approval requests and the transition into signing until required fields are filled', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    // Determine the actual template's first required field to clear.
    const detail = await get(h(), `/api/v1/agreements/${agreement.id}`, user.token);
    const actualTemplateId = detail.json().templateId as string;
    const templateRes = await get(h(), `/api/v1/templates/${actualTemplateId}`, user.token);
    const definition = parseTemplateDefinition(
      (templateRes.json() as { template: { content_schema: unknown } }).template.content_schema,
    )!;
    const requiredCode = definition.fields.find((f) => f.required)!.code;
    const cleared = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { fields: [{ code: requiredCode, value: '', provenance: 'USER_PROVIDED' }] },
      user.token,
    );
    expect(cleared.statusCode).toBe(200);

    // Direct service assertion (same call finalize uses) rejects.
    await expect(assertTemplateComplete(h().db, agreement.id)).rejects.toMatchObject({
      statusCode: 400,
      code: 'MISSING_REQUIRED_FIELDS',
    });

    // Approval request blocked with a clear, actionable error body.
    const approval = await post(
      h(),
      '/api/v1/approvals/request',
      { agreementId: agreement.id },
      user.token,
    );
    expect(approval.statusCode).toBe(400);
    expect(approval.json().code).toBe('MISSING_REQUIRED_FIELDS');
    const errors = approval.json().errors as { missing: Array<{ code: string; label: string }> };
    expect(errors.missing.map((m) => m.code)).toContain(requiredCode);
    expect(approval.json().detail).toContain('required');

    // Submitting to REVIEW is allowed (drafts may be partial)…
    const submit = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'REVIEW' },
      user.token,
    );
    expect(submit.statusCode).toBe(200);

    // …but entering the signing phase is blocked while required fields are blank.
    const blocked = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'AWAITING_SIGNATURES' },
      user.token,
    );
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().code).toBe('MISSING_REQUIRED_FIELDS');

    // Back to DRAFT (changes requested) → fill → gate clears → signing opens.
    const backToDraft = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'DRAFT' },
      user.token,
    );
    expect(backToDraft.statusCode).toBe(200);
    await fillRequiredFields(h(), user.token, agreement.id, actualTemplateId);
    await expect(assertTemplateComplete(h().db, agreement.id)).resolves.toBeUndefined();

    const resubmit = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'REVIEW' },
      user.token,
    );
    expect(resubmit.statusCode).toBe(200);

    // From REVIEW the gate passes → the approval request succeeds…
    const approved = await post(
      h(),
      '/api/v1/approvals/request',
      { agreementId: agreement.id },
      user.token,
    );
    expect(approved.statusCode).toBe(200);

    // …and the signing phase opens.
    const allowed = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'AWAITING_SIGNATURES' },
      user.token,
    );
    expect(allowed.statusCode).toBe(200);
  });
});
