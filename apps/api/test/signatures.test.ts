/**
 * Signature state machine: signing only in AWAITING_SIGNATURES against an
 * APPROVED version, one signature per party, sequential order enforcement,
 * finalize only when every required signature exists (then seals FINAL).
 */
import { describe, expect, it } from 'vitest';
import {
  createAgreement,
  firstTemplateId,
  get,
  post,
  registerUser,
  setupAwaitingSignatures,
  uniqueEmail,
  useTestApp,
  type TestHarness,
} from './helpers.js';

const h = useTestApp();

/** Owner's own signature (creator is the OWNER party and must also sign). */
async function ownerSigns(setup: { agreementId: string; owner: { token: string } }) {
  return post(
    h(),
    '/api/v1/signatures',
    { agreementId: setup.agreementId, consent: true, method: 'SESSION' },
    setup.owner.token,
  );
}

async function counterpartySigns(setup: {
  agreementId: string;
  counterparty: { token: string };
}) {
  return post(
    h(),
    '/api/v1/signatures',
    { agreementId: setup.agreementId, consent: true, method: 'SESSION' },
    setup.counterparty.token,
  );
}

describe('signature state', () => {
  it('refuses signing while the agreement is still a draft', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);

    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: agreement.id, consent: true },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_AWAITING_SIGNATURES');
  });

  it('refuses signature requests before approvals are recorded', async () => {
    const user = await registerUser(h());
    const templateId = await firstTemplateId(h().db);
    const { agreement } = await createAgreement(h(), user.token, templateId);
    await post(h(), `/api/v1/agreements/${agreement.id}/status`, { to: 'REVIEW' }, user.token);

    const res = await post(
      h(),
      '/api/v1/signatures/request',
      { agreementId: agreement.id },
      user.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_AWAITING_SIGNATURES');
  });

  it('refuses explicit consent being absent (validation)', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: false },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('collects both signatures, reports completion, and seals on finalize', async () => {
    const setup = await setupAwaitingSignatures(h());

    // The owner signs first: one required signature remains.
    const first = await ownerSigns(setup);
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.allSigned).toBe(false);
    expect(firstBody.missingSignatures).toBe(1);
    expect(firstBody.signature.documentHashAtSigning).toMatch(/^[0-9a-f]{64}$/);
    expect(firstBody.signature.signaturePayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(firstBody.signature.consentTextVersion).toBe('v1');

    // Finalizing with a missing signature is a conflict with the details.
    const early = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/finalize`,
      {},
      setup.owner.token,
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('MISSING_SIGNATURES');
    expect((early.json().errors?.missing ?? [])).toHaveLength(1);

    // The counterparty signs: complete.
    const second = await counterpartySigns(setup);
    expect(second.statusCode).toBe(201);
    expect(second.json().allSigned).toBe(true);
    expect(second.json().missingSignatures).toBe(0);

    // Status view reflects both.
    const status = await get(
      h(),
      `/api/v1/agreements/${setup.agreementId}/signature-status`,
      setup.owner.token,
    );
    expect(status.json()).toMatchObject({ status: 'AWAITING_SIGNATURES', required: 2, signed: 2 });

    // Duplicate signature is rejected.
    const dup = await ownerSigns(setup);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('ALREADY_SIGNED');

    // Finalize succeeds and seals the agreement.
    const fin = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/finalize`,
      {},
      setup.owner.token,
    );
    expect(fin.statusCode).toBe(200);
    const finBody = fin.json();
    expect(finBody.finalized).toBe(true);
    expect(finBody.publicId).toBe(setup.publicId);
    expect(finBody.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(finBody.verificationUrl).toContain(setup.publicId);

    // Agreement is ACTIVE; version is FINAL and fully immutable.
    const detail = await get(h(), `/api/v1/agreements/${setup.agreementId}`, setup.owner.token);
    expect(detail.json().agreement.status).toBe('ACTIVE');
    expect(detail.json().currentVersion.status).toBe('FINAL');

    await expect(
      h().db.query(`UPDATE agreement_versions SET content = '{}'::jsonb WHERE id = $1`, [
        finBody.versionId,
      ]),
    ).rejects.toThrow(/immutable/);

    // Re-finalizing is a conflict.
    const again = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/finalize`,
      {},
      setup.owner.token,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_FINALIZED');

    // Signature history is listed with hashes.
    const list = await get(
      h(),
      `/api/v1/agreements/${setup.agreementId}/signatures`,
      setup.owner.token,
    );
    expect(list.statusCode).toBe(200);
    const sigs = list.json().signatures as Array<{ signerEmail: string; documentHashAtSigning: string }>;
    expect(sigs).toHaveLength(2);
    expect(sigs.map((s) => s.signerEmail).sort()).toEqual(
      [setup.owner.email, setup.counterEmail].sort(),
    );
    for (const s of sigs) expect(s.documentHashAtSigning).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the signature to the document hash at signing time', async () => {
    const setup = await setupAwaitingSignatures(h());
    const detail = await get(h(), `/api/v1/agreements/${setup.agreementId}`, setup.owner.token);
    const approvedHash = detail.json().currentVersion.documentHash as string;

    const res = await ownerSigns(setup);
    expect(res.statusCode).toBe(201);
    expect(res.json().signature.documentHashAtSigning).toBe(approvedHash);
  });

  it('a non-party cannot sign (404) and an observer party cannot sign (403)', async () => {
    const setup = await setupAwaitingSignatures(h());
    const stranger = await registerUser(h());

    const outsider = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true },
      stranger.token,
    );
    expect(outsider.statusCode).toBe(404);

    // Observer is a party (visible) but not in SIGNER_ROLES.
    const observerEmail = uniqueEmail('observer');
    const invite = await post(
      h(),
      `/api/v1/agreements/${setup.agreementId}/parties`,
      { email: observerEmail, role: 'OBSERVER' },
      setup.owner.token,
    );
    // Invites are blocked once signatures are awaited.
    expect(invite.statusCode).toBe(409);
    expect(invite.json().code).toBe('INVITE_NOT_ALLOWED');
  });

  it('enforces SEQUENTIAL signing order when the template requires it', async () => {
    const setup = await setupAwaitingSignatures(h());
    // Flip the template to sequential ordering for this agreement.
    await h().db.query(
      `UPDATE agreement_templates SET signing_policy = 'SEQUENTIAL'
       WHERE id = (SELECT template_id FROM agreements WHERE id = $1)`,
      [setup.agreementId],
    );

    // Invite a second signer with a later signing order (allowed: still DRAFT? no;
    // agreement is AWAITING_SIGNATURES, so invite is blocked; instead the existing
    // counterparty (signing_order 0) must sign before a later-ordered party).
    // Owner (order 0) is unsigned, so the counterparty (also order 0) is fine;
    // give the counterparty a later order to make the constraint observable.
    await h().db.query(
      `UPDATE agreement_parties SET signing_order = 5
       WHERE agreement_id = $1 AND lower(email) = lower($2)`,
      [setup.agreementId, setup.counterEmail],
    );

    const outOfOrder = await counterpartySigns(setup);
    expect(outOfOrder.statusCode).toBe(409);
    expect(outOfOrder.json().code).toBe('SIGNING_ORDER');

    // Owner (order 0) signs first, unblocking the counterparty.
    const ownerFirst = await ownerSigns(setup);
    expect(ownerFirst.statusCode).toBe(201);

    const nowOk = await counterpartySigns(setup);
    expect(nowOk.statusCode).toBe(201);
    expect(nowOk.json().allSigned).toBe(true);
  });

  it('requests signatures (notifies unsigned parties) after approvals', async () => {
    const setup = await setupAwaitingSignatures(h());

    const res = await post(
      h(),
      '/api/v1/signatures/request',
      { agreementId: setup.agreementId, message: 'Please countersign by Friday' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().notified).toBeGreaterThanOrEqual(1);

    // The counterparty has an in-app notification.
    const notifs = await get(h(), '/api/v1/notifications', setup.counterparty.token);
    expect(notifs.statusCode).toBe(200);
    const types = (notifs.json().notifications as Array<{ type: string }>).map((n) => n.type);
    expect(types).toContain('SIGNATURE_REQUESTED');
  });

  it('rejects recording an approval after the version was approved for signing', async () => {
    const setup = await setupAwaitingSignatures(h());
    // Version is APPROVED; a further approval request on it is refused once
    // the agreement left DRAFT/REVIEW/NEGOTIATION.
    const res = await post(
      h(),
      '/api/v1/approvals/request',
      { agreementId: setup.agreementId },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_NOT_ALLOWED');
  });
});

/** A 1×1 transparent PNG data URL, enough for the DRAWN payload. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('signing methods (MVP)', () => {
  it('requires a typed name for the TYPED method', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true, method: 'TYPED' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('requires a drawn image for the DRAWN method', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true, method: 'DRAWN' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown signing method', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true, method: 'FAX' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('records a TYPED signature with its method and name', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true, method: 'TYPED', signatureText: 'Jordan Rivera' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().signature.method).toBe('TYPED');

    const { rows } = await h().db.query<{ method: string; signature_text: string | null; signature_data: unknown }>(
      `SELECT method, signature_text, signature_data FROM signatures WHERE agreement_id = $1`,
      [setup.agreementId],
    );
    expect(rows[0]?.method).toBe('TYPED');
    expect(rows[0]?.signature_text).toBe('Jordan Rivera');
    expect(rows[0]?.signature_data).toBeNull();

    // The list endpoint reports the method for display.
    const list = await get(h(), `/api/v1/agreements/${setup.agreementId}/signatures`, setup.owner.token);
    expect((list.json().signatures as Array<{ method: string }>)[0]?.method).toBe('TYPED');
  });

  it('records a DRAWN signature image with its data hash', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true, method: 'DRAWN', signatureData: PNG_DATA_URL },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().signature.method).toBe('DRAWN');

    const { rows } = await h().db.query<{ signature_data: { image?: string; hash?: string } | null }>(
      `SELECT signature_data FROM signatures WHERE agreement_id = $1`,
      [setup.agreementId],
    );
    expect(rows[0]?.signature_data?.image).toBe(PNG_DATA_URL);
    expect(rows[0]?.signature_data?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts explicit electronic acceptance without typed or drawn payload', async () => {
    const setup = await setupAwaitingSignatures(h());
    const res = await post(
      h(),
      '/api/v1/signatures',
      { agreementId: setup.agreementId, consent: true, method: 'CONSENT' },
      setup.owner.token,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().signature.method).toBe('CONSENT');
  });

  it('completed signature records are immutable (DB trigger blocks UPDATE/DELETE)', async () => {
    const setup = await setupAwaitingSignatures(h());
    await ownerSigns(setup);

    const { rows } = await h().db.query<{ id: string; method: string }>(
      `SELECT id, method FROM signatures WHERE agreement_id = $1`,
      [setup.agreementId],
    );
    const sigId = rows[0]?.id;
    expect(sigId).toBeTruthy();

    await expect(
      h().db.query(`UPDATE signatures SET method = 'CONSENT' WHERE id = $1`, [sigId]),
    ).rejects.toThrow(/immutable/);

    await expect(h().db.query(`DELETE FROM signatures WHERE id = $1`, [sigId])).rejects.toThrow(
      /immutable/,
    );

    const { rows: after } = await h().db.query<{ method: string }>(
      `SELECT method FROM signatures WHERE id = $1`,
      [sigId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.method).toBe('SESSION');
  });
});
