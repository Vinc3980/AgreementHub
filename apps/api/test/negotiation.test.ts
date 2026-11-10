/**
 * Negotiation & version management:
 *  - every meaningful modification during negotiation creates a new version
 *    with a readable change summary ("Payment modified");
 *  - comments record author / timestamp / section / content / status;
 *  - change proposals: suggest → accept/reject, and the guarantee that the
 *    system never changes contractual terms by itself;
 *  - the post-finalization amendment workflow (final version stays sealed);
 *  - word-level diff helper used by the comparison UI.
 */
import { describe, expect, it } from 'vitest';
import { diffWords, joinTokens } from '@agreementhub/domain';
import { parseTemplateDefinition } from '@agreementhub/domain/template';
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

interface VersionListEntry {
  id: string;
  versionNumber: number;
  status: string;
  changeSummary: string;
  documentHash: string;
}

interface DetailShape {
  agreement: { id: string; title: string; status: string; publicId: string };
  sections: Array<{ id: string; code: string; title: string; body: string; included: boolean }>;
  fields: Array<{ id: string; code: string; value: unknown; provenance: string }>;
  currentVersion: { id: string; versionNumber: number; status: string } | null;
}

async function versionsOf(token: string, agreementId: string): Promise<VersionListEntry[]> {
  const res = await get(h(), `/api/v1/agreements/${agreementId}/versions`, token);
  expect(res.statusCode).toBe(200);
  return res.json().versions as VersionListEntry[];
}

async function detailOf(token: string, agreementId: string): Promise<DetailShape> {
  const res = await get(h(), `/api/v1/agreements/${agreementId}`, token);
  expect(res.statusCode).toBe(200);
  return res.json() as DetailShape;
}

async function openNegotiation(token: string, agreementId: string): Promise<void> {
  const review = await post(
    h(),
    `/api/v1/agreements/${agreementId}/status`,
    { to: 'REVIEW' },
    token,
  );
  expect(review.statusCode).toBe(200);
  const negotiation = await post(
    h(),
    `/api/v1/agreements/${agreementId}/status`,
    { to: 'NEGOTIATION' },
    token,
  );
  expect(negotiation.statusCode).toBe(200);
}

async function auditTypes(agreementId: string): Promise<string[]> {
  const { rows } = await h().db.query<{ event_type: string }>(
    `SELECT event_type FROM audit_events WHERE agreement_id = $1 ORDER BY seq ASC`,
    [agreementId],
  );
  return rows.map((r) => r.event_type);
}

/** Drive an agreement all the way to a sealed final version. */
async function finalizedAgreement() {
  const setup = await setupAwaitingSignatures(h());
  const ownerSign = await post(
    h(),
    '/api/v1/signatures',
    { agreementId: setup.agreementId, consent: true, method: 'SESSION' },
    setup.owner.token,
  );
  expect(ownerSign.statusCode).toBe(201);
  const counterSign = await post(
    h(),
    '/api/v1/signatures',
    { agreementId: setup.agreementId, consent: true, method: 'SESSION' },
    setup.counterparty.token,
  );
  expect(counterSign.statusCode).toBe(201);
  const fin = await post(
    h(),
    `/api/v1/agreements/${setup.agreementId}/finalize`,
    {},
    setup.owner.token,
  );
  expect(fin.statusCode).toBe(200);
  return {
    setup,
    final: fin.json() as {
      documentHash: string;
      versionId: string;
      versionNumber: number;
      publicId: string;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Versioning during negotiation                                       */
/* ------------------------------------------------------------------ */

describe('versioning during negotiation', () => {
  it('creates a new version for every meaningful modification', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await openNegotiation(user.token, agreement.id);

    const before = await detailOf(user.token, agreement.id);
    const section = before.sections[0]!;
    const edit = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { sections: [{ code: section.code, title: section.title, body: 'Negotiated wording.', included: true }] },
      user.token,
    );
    expect(edit.statusCode).toBe(200);

    const versions = await versionsOf(user.token, agreement.id);
    expect(versions).toHaveLength(2);
    // v1 frozen, v2 is the new working version with a readable summary.
    expect(versions[0]!.status).toBe('SUPERSEDED');
    expect(versions[1]!.versionNumber).toBe(2);
    expect(versions[1]!.status).toBe('DRAFT');
    expect(versions[1]!.changeSummary).toBe(`${section.title} modified`);

    const after = await detailOf(user.token, agreement.id);
    expect(after.currentVersion?.versionNumber).toBe(2);

    // A second meaningful change (a field value) becomes v3.
    const field = after.fields[0]!;
    const fieldEdit = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { fields: [{ code: field.code, value: 'renegotiated-value', provenance: 'USER_PROVIDED' }] },
      user.token,
    );
    expect(fieldEdit.statusCode).toBe(200);

    const versions2 = await versionsOf(user.token, agreement.id);
    expect(versions2).toHaveLength(3);
    expect(versions2[2]!.versionNumber).toBe(3);
    expect(versions2[2]!.changeSummary).toMatch(/modified$/);
    expect(versions2[2]!.changeSummary).not.toBe('Working copy updated');
    expect(versions2[1]!.status).toBe('SUPERSEDED');
  });

  it('does not create a version when nothing actually changed', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await openNegotiation(user.token, agreement.id);

    const detail = await detailOf(user.token, agreement.id);
    const section = detail.sections[0]!;
    const res = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      {
        title: detail.agreement.title,
        sections: [{ code: section.code, title: section.title, body: section.body, included: section.included }],
      },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    expect(await versionsOf(user.token, agreement.id)).toHaveLength(1);
  });

  it('keeps editing the draft version in place while still in DRAFT', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);

    const detail = await detailOf(user.token, agreement.id);
    const section = detail.sections[0]!;
    const res = await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { sections: [{ code: section.code, title: section.title, body: 'Draft-only body.', included: true }] },
      user.token,
    );
    expect(res.statusCode).toBe(200);

    // No new version: the working DRAFT snapshot was refreshed in place.
    const versions = await versionsOf(user.token, agreement.id);
    expect(versions).toHaveLength(1);
    const stored = await get(h(), `/api/v1/versions/${initialVersion.id}`, user.token);
    const content = stored.json().version.content as {
      sections: Array<{ code: string; body: string }>;
    };
    expect(content.sections.find((s) => s.code === section.code)?.body).toBe('Draft-only body.');
  });

  it('reports field value changes in a two-version comparison', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement, initialVersion } = await createAgreement(h(), user.token, templateId);
    await openNegotiation(user.token, agreement.id);

    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;
    await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { fields: [{ code: field.code, value: '8000', provenance: 'USER_PROVIDED' }] },
      user.token,
    );

    const versions = await versionsOf(user.token, agreement.id);
    const v2 = versions[1]!;
    const diff = await get(
      h(),
      `/api/v1/versions/${initialVersion.id}/diff/${v2.id}`,
      user.token,
    );
    expect(diff.statusCode).toBe(200);
    const changes = diff.json().diff.changes as Array<{
      kind: string;
      code: string;
      change: string;
      from?: { value: unknown };
      to?: { value: unknown };
    }>;
    const fieldChange = changes.find((c) => c.kind === 'field' && c.code === field.code);
    expect(fieldChange?.change).toBe('modified');
    expect(fieldChange?.to?.value).toBe('8000');
    expect(fieldChange?.from?.value).not.toBe('8000');
  });

  it('records the auto-created version in the audit trail', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await openNegotiation(user.token, agreement.id);

    const detail = await detailOf(user.token, agreement.id);
    const section = detail.sections[0]!;
    await patch(
      h(),
      `/api/v1/agreements/${agreement.id}`,
      { sections: [{ code: section.code, title: section.title, body: 'Audited change.', included: true }] },
      user.token,
    );

    const types = await auditTypes(agreement.id);
    expect(types).toContain('AGREEMENT_UPDATED');
    const updated = await h().db.query<{ metadata: { newVersionNumber?: number } }>(
      `SELECT metadata FROM audit_events WHERE agreement_id = $1 AND event_type = 'AGREEMENT_UPDATED'
       ORDER BY seq DESC LIMIT 1`,
      [agreement.id],
    );
    expect(updated.rows[0]?.metadata.newVersionNumber).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Template generation & version sync                                  */
/* ------------------------------------------------------------------ */

/** First free-text field of a template (used to drive the generate route). */
async function firstTextField(templateId: string, token: string): Promise<string> {
  const res = await get(h(), `/api/v1/templates/${templateId}`, token);
  expect(res.statusCode).toBe(200);
  const definition = parseTemplateDefinition(res.json().template.content_schema);
  expect(definition).not.toBeNull();
  const field = definition!.fields.find((f) =>
    ['text', 'textarea', 'email'].includes(f.type),
  );
  expect(field, 'seeded template should expose a text field').toBeDefined();
  return field!.code;
}

describe('template generation stays versioned', () => {
  it('refreshes the DRAFT version in place so snapshots never go stale', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const code = await firstTextField(templateId, user.token);

    // Generation rewrites section bodies (placeholders → real values); the
    // version snapshot must follow instead of drifting from the working copy.
    const gen = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/generate`,
      { values: { [code]: 'Northwind Retail Ltd' } },
      user.token,
    );
    expect(gen.statusCode).toBe(200);

    const versions = await versionsOf(user.token, agreement.id);
    expect(versions).toHaveLength(1); // still DRAFT ⇒ refreshed, never forked

    const detail = await detailOf(user.token, agreement.id);
    const snapshot = await get(h(), `/api/v1/versions/${versions[0]!.id}`, user.token);
    expect(snapshot.statusCode).toBe(200);
    const content = (
      snapshot.json() as {
        version: { content: { sections: Array<{ code: string; body: string }> } };
      }
    ).version.content;
    for (const section of detail.sections) {
      expect(content.sections.find((s) => s.code === section.code)?.body).toBe(section.body);
    }
  });

  it('creates a version when generation changes the document during negotiation', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const code = await firstTextField(templateId, user.token);
    await openNegotiation(user.token, agreement.id);

    const gen = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/generate`,
      { values: { [code]: 'Acme Holdings' } },
      user.token,
    );
    expect(gen.statusCode).toBe(200);

    const versions = await versionsOf(user.token, agreement.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.status).toBe('SUPERSEDED');
    expect(versions[1]!.versionNumber).toBe(2);
    expect(versions[1]!.changeSummary).toMatch(/modified$/);

    // Re-generating identical content is a no-op: no third version.
    const again = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/template/generate`,
      { values: { [code]: 'Acme Holdings' } },
      user.token,
    );
    expect(again.statusCode).toBe(200);
    expect(await versionsOf(user.token, agreement.id)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

describe('section comments', () => {
  it('records author, timestamp, section, content and status', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const detail = await detailOf(user.token, agreement.id);
    const section = detail.sections[0]!;

    const created = await post(
      h(),
      '/api/v1/comments',
      {
        agreementId: agreement.id,
        sectionCode: section.code,
        body: 'I would prefer five revisions instead of three.',
      },
      user.token,
    );
    expect(created.statusCode).toBe(201);
    const comment = created.json().comment as Record<string, unknown>;
    expect(comment.status).toBe('OPEN');
    expect(comment.authorLabel).toBe(user.email);
    expect(comment.sectionCode).toBe(section.code);
    expect(comment.body).toContain('five revisions');
    expect(typeof comment.createdAt).toBe('string');
    expect(comment.resolvedAt).toBeNull();

    const list = await get(h(), `/api/v1/comments?agreementId=${agreement.id}`, user.token);
    expect(list.statusCode).toBe(200);
    const comments = list.json().comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.status).toBe('OPEN');
  });

  it('lets the author resolve and reopen a comment', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const created = await post(
      h(),
      '/api/v1/comments',
      { agreementId: agreement.id, body: 'Accepted.' },
      user.token,
    );
    const id = created.json().comment.id as string;

    const resolved = await patch(h(), `/api/v1/comments/${id}`, { status: 'RESOLVED' }, user.token);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().comment.status).toBe('RESOLVED');
    expect(resolved.json().comment.resolvedAt).toBeTruthy();

    const reopened = await patch(h(), `/api/v1/comments/${id}`, { status: 'OPEN' }, user.token);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().comment.status).toBe('OPEN');
    expect(reopened.json().comment.resolvedAt).toBeNull();

    const types = await auditTypes(agreement.id);
    expect(types.filter((t) => t === 'COMMENT_STATUS_CHANGED')).toHaveLength(2);
  });

  it('refuses status changes by parties who are neither author nor manager', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);

    const created = await post(
      h(),
      '/api/v1/comments',
      { agreementId: agreement.id, body: 'Owner comment.' },
      owner.token,
    );
    const id = created.json().comment.id as string;

    // A REVIEWER party can see the agreement but may not manage it.
    const reviewerEmail = uniqueEmail('reviewer');
    const invite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: reviewerEmail, role: 'REVIEWER' },
      owner.token,
    );
    expect(invite.statusCode).toBe(201);
    const reviewer = await registerUser(h(), reviewerEmail);

    const forbidden = await patch(
      h(),
      `/api/v1/comments/${id}`,
      { status: 'RESOLVED' },
      reviewer.token,
    );
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('FORBIDDEN');

    // Someone with no access at all gets 404 (no existence leak).
    const outsider = await registerUser(h());
    const invisible = await patch(
      h(),
      `/api/v1/comments/${id}`,
      { status: 'RESOLVED' },
      outsider.token,
    );
    expect(invisible.statusCode).toBe(404);
  });

  it('closes commenting on a terminated/cancelled agreement', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const cancel = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/cancel`,
      { reason: 'walked away' },
      user.token,
    );
    expect(cancel.statusCode).toBe(200);

    const res = await post(
      h(),
      '/api/v1/comments',
      { agreementId: agreement.id, body: 'Too late.' },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGREEMENT_CLOSED');
  });
});

/* ------------------------------------------------------------------ */
/* Change proposals (suggest / accept / reject)                        */
/* ------------------------------------------------------------------ */

describe('change proposals', () => {
  it('records a suggestion without touching the document', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;

    const res = await post(
      h(),
      '/api/v1/proposals',
      {
        agreementId: agreement.id,
        kind: 'FIELD',
        targetCode: field.code,
        proposedValue: 'suggested-but-not-applied',
        note: 'Client asks for a different value.',
      },
      user.token,
    );
    expect(res.statusCode).toBe(201);
    const proposal = res.json().proposal as Record<string, unknown>;
    expect(proposal.status).toBe('PENDING');
    expect(proposal.currentValue).toBe(field.value);
    expect(proposal.proposedValue).toBe('suggested-but-not-applied');
    expect(proposal.proposedByLabel).toBe(user.email);

    // The document and the version list are untouched, no automatic change.
    const after = await detailOf(user.token, agreement.id);
    expect(after.fields.find((f) => f.code === field.code)?.value).toBe(field.value);
    expect(await versionsOf(user.token, agreement.id)).toHaveLength(1);

    const types = await auditTypes(agreement.id);
    expect(types).toContain('CHANGE_SUGGESTED');
    expect(types).not.toContain('CHANGE_ACCEPTED');
  });

  it('rejecting a suggestion leaves the document untouched', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;

    const created = await post(
      h(),
      '/api/v1/proposals',
      {
        agreementId: agreement.id,
        kind: 'FIELD',
        targetCode: field.code,
        proposedValue: 'rejected-value',
      },
      user.token,
    );
    const id = created.json().proposal.id as string;

    const decided = await post(
      h(),
      `/api/v1/proposals/${id}/decide`,
      { decision: 'REJECTED', note: 'Keep the original term.' },
      user.token,
    );
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe('REJECTED');
    expect(decided.json().versionCreated).toBeNull();

    const after = await detailOf(user.token, agreement.id);
    expect(after.fields.find((f) => f.code === field.code)?.value).toBe(field.value);
    expect(await versionsOf(user.token, agreement.id)).toHaveLength(1);
    expect(await auditTypes(agreement.id)).toContain('CHANGE_REJECTED');
  });

  it('accepting a suggestion applies it explicitly and creates a version', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await openNegotiation(user.token, agreement.id);

    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;
    const created = await post(
      h(),
      '/api/v1/proposals',
      {
        agreementId: agreement.id,
        kind: 'FIELD',
        targetCode: field.code,
        proposedValue: 'agreed-value',
        note: 'Provider accepts.',
      },
      user.token,
    );
    expect(created.statusCode).toBe(201);
    const id = created.json().proposal.id as string;

    const accepted = await post(
      h(),
      `/api/v1/proposals/${id}/decide`,
      { decision: 'ACCEPTED' },
      user.token,
    );
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json() as {
      proposal: { status: string; decidedBy: string | null; decidedAt: string | null };
      versionCreated: { versionNumber: number; changeSummary: string } | null;
    };
    expect(body.proposal.status).toBe('ACCEPTED');
    expect(body.proposal.decidedBy).toBe(user.userId);
    expect(body.proposal.decidedAt).toBeTruthy();
    // Accepting during negotiation is a meaningful modification ⇒ new version.
    expect(body.versionCreated?.versionNumber).toBe(2);

    const after = await detailOf(user.token, agreement.id);
    expect(after.fields.find((f) => f.code === field.code)?.value).toBe('agreed-value');
    expect(after.fields.find((f) => f.code === field.code)?.provenance).toBe('USER_PROVIDED');
    expect(await versionsOf(user.token, agreement.id)).toHaveLength(2);
    expect(await auditTypes(agreement.id)).toContain('CHANGE_ACCEPTED');
  });

  it('validates the suggestion target and value', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;

    const unknownField = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: 'does_not_exist', proposedValue: 'x' },
      user.token,
    );
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().code).toBe('UNKNOWN_FIELD');

    const unknownSection = await post(
      h(),
      '/api/v1/proposals',
      {
        agreementId: agreement.id,
        kind: 'SECTION',
        targetCode: 'nope',
        proposedValue: { body: 'x' },
      },
      user.token,
    );
    expect(unknownSection.statusCode).toBe(400);
    expect(unknownSection.json().code).toBe('UNKNOWN_SECTION');

    const noValue = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: field.code },
      user.token,
    );
    expect(noValue.statusCode).toBe(400);
    expect(noValue.json().code).toBe('INVALID_PROPOSAL_VALUE');

    const identical = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: field.code, proposedValue: field.value },
      user.token,
    );
    expect(identical.statusCode).toBe(400);
    expect(identical.json().code).toBe('NO_CHANGE');
  });

  it('allows only one open suggestion per target', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;

    const first = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: field.code, proposedValue: 'first' },
      user.token,
    );
    expect(first.statusCode).toBe(201);

    const second = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: field.code, proposedValue: 'second' },
      user.token,
    );
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('PROPOSAL_EXISTS');
  });

  it('refuses acceptance from a party without edit rights', async () => {
    const owner = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), owner.token, templateId);
    const detail = await detailOf(owner.token, agreement.id);
    const field = detail.fields[0]!;

    const reviewerEmail = uniqueEmail('reviewer');
    const invite = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/parties`,
      { email: reviewerEmail, role: 'REVIEWER' },
      owner.token,
    );
    expect(invite.statusCode).toBe(201);
    const reviewer = await registerUser(h(), reviewerEmail);

    const created = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: field.code, proposedValue: 'nope' },
      reviewer.token,
    );
    expect(created.statusCode).toBe(201);

    const decided = await post(
      h(),
      `/api/v1/proposals/${created.json().proposal.id}/decide`,
      { decision: 'ACCEPTED' },
      reviewer.token,
    );
    expect(decided.statusCode).toBe(403);
    expect(decided.json().code).toBe('FORBIDDEN');

    // Rejection (no document change) is allowed for any party that can see it.
    const rejected = await post(
      h(),
      `/api/v1/proposals/${created.json().proposal.id}/decide`,
      { decision: 'REJECTED' },
      reviewer.token,
    );
    expect(rejected.statusCode).toBe(200);
  });

  it('refuses to apply a suggestion once review has started', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await openNegotiation(user.token, agreement.id);
    const detail = await detailOf(user.token, agreement.id);
    const field = detail.fields[0]!;

    const created = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: agreement.id, kind: 'FIELD', targetCode: field.code, proposedValue: 'later' },
      user.token,
    );
    const id = created.json().proposal.id as string;

    const backToReview = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/status`,
      { to: 'REVIEW' },
      user.token,
    );
    expect(backToReview.statusCode).toBe(200);

    const decided = await post(
      h(),
      `/api/v1/proposals/${id}/decide`,
      { decision: 'ACCEPTED' },
      user.token,
    );
    expect(decided.statusCode).toBe(409);
    expect(decided.json().code).toBe('NOT_DRAFT');
  });

  it('closes suggestions while signatures are awaited', async () => {
    const setup = await setupAwaitingSignatures(h());
    const detail = await detailOf(setup.owner.token, setup.agreementId);
    const field = detail.fields[0]!;

    const res = await post(
      h(),
      '/api/v1/proposals',
      { agreementId: setup.agreementId, kind: 'FIELD', targetCode: field.code, proposedValue: 'x' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NEGOTIATION_CLOSED');
  });

  it('hides proposals from users without access (no IDOR)', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    const outsider = await registerUser(h());

    const res = await get(h(), `/api/v1/agreements/${agreement.id}/proposals`, outsider.token);
    expect(res.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Amendment workflow                                                  */
/* ------------------------------------------------------------------ */

describe('amendment workflow after finalization', () => {
  it('locks a finalized agreement against edits and version creation', async () => {
    const { setup } = await finalizedAgreement();

    const edit = await patch(
      h(),
      `/api/v1/agreements/${setup.agreementId}`,
      { title: 'Sneaky rename' },
      setup.owner.token,
    );
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe('NOT_DRAFT');

    const version = await post(
      h(),
      '/api/v1/versions',
      { agreementId: setup.agreementId, changeSummary: 'sneaky version' },
      setup.owner.token,
    );
    expect(version.statusCode).toBe(409);
    expect(version.json().code).toBe('VERSION_LOCKED');

    // The generic status route refuses to re-open it: no seeding, no change.
    const reopen = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/status`,
      { to: 'NEGOTIATION' },
      setup.owner.token,
    );
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().code).toBe('AMENDMENT_REQUIRED');
  });

  it('starts an amendment by seeding a new version from the final document', async () => {
    const { setup, final } = await finalizedAgreement();

    const res = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/amendments`,
      {},
      setup.owner.token,
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      agreement: { status: string };
      version: { versionNumber: number; documentHash: string; changeSummary: string };
      finalVersionNumber: number;
    };
    expect(body.agreement.status).toBe('NEGOTIATION');
    expect(body.version.versionNumber).toBe(final.versionNumber + 1);
    expect(body.version.documentHash).toBe(final.documentHash);
    expect(body.version.changeSummary).toBe(`Amendment to v${final.versionNumber}`);

    // The sealed final version keeps FINAL status and its hash forever.
    const finalRow = await h().db.query<{ status: string; document_hash: string }>(
      `SELECT status, document_hash FROM agreement_versions WHERE id = $1`,
      [final.versionId],
    );
    expect(finalRow.rows[0]!.status).toBe('FINAL');
    expect(finalRow.rows[0]!.document_hash).toBe(final.documentHash);

    // Public verification still reports the sealed document as verified.
    const verify = await get(h(), `/api/v1/verification/${final.publicId}`);
    expect(verify.statusCode).toBe(200);
    expect(verify.json().integrity).toBe('VERIFIED');

    expect(await auditTypes(setup.agreementId)).toContain('AMENDMENT_STARTED');
  });

  it('lets negotiated edits create versions again and re-seal later', async () => {
    const { setup, final } = await finalizedAgreement();
    await post(h(), `/api/v1/agreements/${setup.agreementId}/amendments`, {}, setup.owner.token);

    const detail = await detailOf(setup.owner.token, setup.agreementId);
    const section = detail.sections[0]!;
    const edit = await patch(
      h(),
      `/api/v1/agreements/${setup.agreementId}`,
      { sections: [{ code: section.code, title: section.title, body: 'Amended wording.', included: true }] },
      setup.owner.token,
    );
    expect(edit.statusCode).toBe(200);

    const versions = await versionsOf(setup.owner.token, setup.agreementId);
    expect(versions).toHaveLength(final.versionNumber + 2);
    expect(versions[versions.length - 1]!.changeSummary).toBe(`${section.title} modified`);
    // The original final row is untouched by the amendment edits.
    const finalRow = await h().db.query<{ status: string; document_hash: string }>(
      `SELECT status, document_hash FROM agreement_versions WHERE id = $1`,
      [final.versionId],
    );
    expect(finalRow.rows[0]!.status).toBe('FINAL');
    expect(finalRow.rows[0]!.document_hash).toBe(final.documentHash);
  });

  it('refuses amendments before finalization and for non-managers', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const early = await post(
      h(),
      `/api/v1/agreements/${agreement.id}/amendments`,
      {},
      user.token,
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('NOT_FINALIZED');

    const { setup } = await finalizedAgreement();
    const outsider = await registerUser(h());
    const forbidden = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/amendments`,
      {},
      outsider.token,
    );
    expect(forbidden.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Word-level diff (comparison highlighting)                           */
/* ------------------------------------------------------------------ */

describe('word diff', () => {
  it('round-trips the original text on both sides', () => {
    const before = 'The client pays 8,000 cedis on delivery.';
    const after = 'The client pays 10,000 cedis on delivery.';
    const diff = diffWords(before, after);

    expect(joinTokens(diff.before)).toBe(before);
    expect(joinTokens(diff.after)).toBe(after);
    expect(diff.before.some((t) => t.op === 'removed' && t.text === '8,000')).toBe(true);
    expect(diff.after.some((t) => t.op === 'added' && t.text === '10,000')).toBe(true);
    expect(diff.before.filter((t) => t.op === 'removed')).toHaveLength(1);
    expect(diff.after.filter((t) => t.op === 'added')).toHaveLength(1);
  });

  it('marks identical text as entirely unchanged', () => {
    const text = 'No changes here.';
    const diff = diffWords(text, text);
    expect(diff.before.every((t) => t.op === 'same')).toBe(true);
    expect(diff.after.every((t) => t.op === 'same')).toBe(true);
  });

  it('handles insertions and deletions at the edges', () => {
    const before = 'middle content';
    const after = 'new prefix middle content';
    const diff = diffWords(before, after);
    expect(joinTokens(diff.before)).toBe(before);
    expect(joinTokens(diff.after)).toBe(after);
    expect(diff.before.some((t) => t.op === 'removed')).toBe(false);
    expect(diff.after.some((t) => t.op === 'added' && t.text === 'new')).toBe(true);
    expect(diff.after.some((t) => t.op === 'added' && t.text === 'prefix')).toBe(true);
  });
});
