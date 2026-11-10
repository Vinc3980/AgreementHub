/**
 * Signature service (SPEC §13): requestSignature notifies signers,
 * recordSignature binds signer identity + consent to the version hash,
 * finalizeAgreement seals the final version and creates the verification
 * record once every required signature exists.
 */
import { AppError, canonicalJson, sha256Hex } from '@agreementhub/domain';
import type { Config } from '../config.js';
import { webBaseUrl } from '../config.js';
import type { Db } from '../db.js';
import { exec, many, one, withTransaction, type Queryable } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import {
  SIGNER_ROLES,
  requireAccess,
  requireManage,
  requireSigner,
} from './access.js';
import { recordAudit } from './audit.js';
import { buildDocumentHtml } from './documentHtml.js';
import { renderPdf } from './pdf.js';
import { documentPdfKey, putDocumentPdf } from './storage.js';
import { notify, notifyParties } from './notifications.js';
import { getVersion } from './versions.js';
import { assertTemplateComplete } from './templateEngine.js';
import { consumeSignatureOtp } from './signatureOtp.js';

export interface SignatureRow {
  id: string;
  agreement_id: string;
  version_id: string;
  party_id: string;
  signer_user_id: string | null;
  signer_email: string;
  method: string;
  signed_at: Date;
  document_hash_at_signing: string;
  signature_payload_hash: string;
  signature_text: string | null;
  consent_text_version: string;
  identity_assurance: string;
}

interface SignerState {
  party_id: string;
  email: string;
  role: string;
  signing_order: number;
  has_signed: boolean;
}

/**
 * Required signers for an exact version = parties whose role is in SIGNER_ROLES
 * and are not DECLINED. A signature only counts when it was recorded against
 * this version, signatures on a previous (superseded/amended) version never
 * satisfy the current one. Sequential policy additionally requires
 * signing_order order.
 */
async function requiredSigners(db: Queryable, agreementId: string, versionId: string) {
  return many<SignerState>(
    db,
    `SELECT p.id AS party_id, p.email, p.role, p.signing_order,
            EXISTS(SELECT 1 FROM signatures s
                   WHERE s.party_id = p.id
                     AND s.agreement_id = p.agreement_id
                     AND s.version_id = $3) AS has_signed
     FROM agreement_parties p
     WHERE p.agreement_id = $1
       AND p.role = ANY($2)
       AND p.status <> 'DECLINED'
     ORDER BY p.signing_order, p.added_at`,
    [agreementId, `{${SIGNER_ROLES.join(',')}}`, versionId],
  );
}

export async function requestSignature(
  db: Db,
  ctx: ActorContext,
  input: { agreementId: string; versionId?: string; message?: string },
): Promise<{ versionId: string; notified: number }> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, input.agreementId);
    requireManage(access);

    if (access.agreement.status !== 'AWAITING_SIGNATURES') {
      throw AppError.conflict(
        'NOT_AWAITING_SIGNATURES',
        `Signature requests require AWAITING_SIGNATURES status (current: ${access.agreement.status}).`,
      );
    }
    // Required template information must be complete before signing starts.
    await assertTemplateComplete(tx, input.agreementId);
    const versionId = input.versionId ?? access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version.');
    const version = await getVersion(tx, versionId);
    if (!version || version.agreement_id !== input.agreementId) {
      throw AppError.notFound('Version not found.');
    }
    if (version.status !== 'APPROVED') {
      throw AppError.conflict(
        'VERSION_NOT_APPROVED',
        `Only an APPROVED version can be sent for signing (current: ${version.status}).`,
      );
    }

    const signers = await requiredSigners(tx, input.agreementId, versionId);
    let notified = 0;
    for (const signer of signers.filter((s) => !s.has_signed)) {
      const party = await one<{ user_id: string | null }>(
        tx,
        `SELECT user_id FROM agreement_parties WHERE id = $1`,
        [signer.party_id],
      );
      if (party?.user_id) {
        await notify(tx, {
          userId: party.user_id,
          type: 'SIGNATURE_REQUESTED',
          orgId: access.agreement.org_id,
          agreementId: input.agreementId,
          payload: {
            publicId: access.agreement.public_id,
            title: access.agreement.title,
            message: input.message ?? null,
          },
          dedupeKey: `sigreq:${versionId}:${signer.party_id}`,
        });
        notified += 1;
      }
    }

    await recordAudit(tx, {
      agreementId: input.agreementId,
      orgId: access.agreement.org_id,
      eventType: 'SIGNATURE_REQUESTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        versionId,
        versionNumber: version.version_number,
        signers: signers.filter((s) => !s.has_signed).length,
        notified,
        documentHash: version.document_hash,
      },
      requestId: ctx.requestId,
    });

    return { versionId, notified };
  });
}

export interface RecordSignatureInput {
  agreementId: string;
  consent: true;
  signatureText?: string;
  /** Drawn signature image data URL (method DRAWN). */
  signatureData?: string;
  method: 'SESSION' | 'EMAIL_OTP' | 'TYPED' | 'DRAWN' | 'CONSENT';
  /** Six-digit code emailed to the signer (required for EMAIL_OTP). */
  otpCode?: string;
}

export async function recordSignature(
  db: Db,
  ctx: ActorContext,
  input: RecordSignatureInput,
): Promise<{ signature: SignatureRow; complete: boolean; missing: number }> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, input.agreementId);
    const party = requireSigner(access);

    if (access.agreement.status !== 'AWAITING_SIGNATURES') {
      throw AppError.conflict(
        'NOT_AWAITING_SIGNATURES',
        `Signing requires AWAITING_SIGNATURES status (current: ${access.agreement.status}).`,
      );
    }
    const versionId = access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version.');
    const version = await getVersion(tx, versionId);
    if (!version || version.status !== 'APPROVED') {
      throw AppError.conflict('VERSION_NOT_APPROVED', 'The current version is not approved for signing.');
    }

    // Sequential signing order (template.signing_policy = SEQUENTIAL).
    const template = await one<{ signing_policy: 'PARALLEL' | 'SEQUENTIAL' }>(
      tx,
      `SELECT t.signing_policy FROM agreement_templates t
       JOIN agreements a ON a.template_id = t.id WHERE a.id = $1`,
      [input.agreementId],
    );
    if (template?.signing_policy === 'SEQUENTIAL') {
      const signers = await requiredSigners(tx, input.agreementId, versionId);
      const earlier = signers.filter((s) => s.signing_order < party.signing_order);
      const unsignedEarlier = earlier.filter((s) => !s.has_signed);
      if (unsignedEarlier.length > 0) {
        throw AppError.conflict(
          'SIGNING_ORDER',
          `${unsignedEarlier.length} party(s) with an earlier signing order must sign first.`,
        );
      }
    }

    // One signature per party per version (DB also enforces UNIQUE(version_id, party_id)).
    const existing = await one<{ id: string }>(
      tx,
      `SELECT id FROM signatures WHERE version_id = $1 AND party_id = $2`,
      [versionId, party.id],
    );
    if (existing) {
      throw AppError.conflict('ALREADY_SIGNED', 'You have already signed this version.');
    }

    // EMAIL_OTP is only valid when the code was actually emailed and consumed
    // inside this transaction. A client cannot "claim" the method.
    if (input.method === 'EMAIL_OTP') {
      if (!input.otpCode) {
        throw AppError.badRequest('OTP_REQUIRED', 'Enter the emailed signing code to sign with EMAIL_OTP.');
      }
      await consumeSignatureOtp(tx, {
        agreementId: input.agreementId,
        versionId,
        partyId: party.id,
        signerEmail: party.email,
        code: input.otpCode,
      });
    }

    const signedAt = new Date().toISOString();
    const nonce = sha256Hex(canonicalJson({ userId: ctx.userId, at: signedAt, salt: ctx.requestId }));
    const signatureDataHash = input.signatureData ? sha256Hex(input.signatureData) : null;
    const identityAssurance =
      input.method === 'EMAIL_OTP' ? 'EMAIL_OTP_VERIFIED' : 'AUTHENTICATED_SESSION';
    // Exact canonical payload persisted alongside the digest so verification
    // can recompute it instead of assuming the stored hash is genuine.
    const payloadSnapshot = {
      agreementId: input.agreementId,
      agreementPublicId: access.agreement.public_id,
      versionId,
      versionNumber: version.version_number,
      documentHash: version.document_hash,
      signerUserId: ctx.userId,
      signerEmail: ctx.email,
      partyId: party.id,
      signedAt,
      nonce,
      consent: true,
      consentTextVersion: 'v1',
      // Bind the signing method and its payload to the record: a later
      // method swap would change the hash and break verification.
      method: input.method,
      identityAssurance,
      signatureText: input.signatureText ?? null,
      signatureDataHash,
    };
    const payloadHash = sha256Hex(canonicalJson(payloadSnapshot));

    const signature = await one<SignatureRow>(
      tx,
      `INSERT INTO signatures
         (agreement_id, version_id, party_id, signer_user_id, signer_email, method,
          document_hash_at_signing, signature_payload_hash, signature_text,
          signature_data, consent_text_version, actor_ip, actor_ua,
          payload_snapshot, identity_assurance, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'v1',$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.agreementId,
        versionId,
        party.id,
        ctx.userId,
        ctx.email,
        input.method,
        version.document_hash,
        payloadHash,
        input.signatureText ?? null,
        input.signatureData ? { image: input.signatureData, hash: signatureDataHash } : null,
        ctx.ip ?? null,
        ctx.userAgent ?? null,
        JSON.stringify(payloadSnapshot),
        identityAssurance,
        ctx.requestId,
      ],
    );
    if (!signature) throw AppError.internal('Failed to record signature.');

    await exec(tx, `UPDATE agreement_parties SET status = 'SIGNED', signed_at = now() WHERE id = $1`, [
      party.id,
    ]);

    await recordAudit(tx, {
      agreementId: input.agreementId,
      orgId: access.agreement.org_id,
      eventType: 'DOCUMENT_SIGNED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        versionId,
        versionNumber: version.version_number,
        partyId: party.id,
        method: input.method,
        identityAssurance,
        documentHash: version.document_hash,
        signaturePayloadHash: payloadHash,
        signatureDataHash,
        consentTextVersion: 'v1',
      },
      requestId: ctx.requestId,
    });

    await notifyParties(
      tx,
      input.agreementId,
      access.agreement.org_id,
      'DOCUMENT_SIGNED',
      { publicId: access.agreement.public_id, title: access.agreement.title, signer: ctx.email },
      ctx.userId,
    );

    const signers = await requiredSigners(tx, input.agreementId, versionId);
    const missing = signers.filter((s) => !s.has_signed).length;
    return { signature, complete: missing === 0, missing };
  });
}

export interface FinalizeResult {
  finalized: true;
  publicId: string;
  versionId: string;
  versionNumber: number;
  documentHash: string;
  verificationUrl: string;
  /** SHA-256 of the immutable final PDF (null when PDF generation is off). */
  pdfSha256: string | null;
}

/**
 * Finalize: seals the current version (FINAL), stamps finalization time,
 * moves the agreement to ACTIVE, and creates the initial verification record.
 * Also runs the document pipeline (HTML → PDF → hash → storage) so a
 * finalized agreement always has its immutable final PDF, generated inside
 * the same transaction, so either the whole finalization happens or none
 * of it does. Idempotent: re-finalizing is a conflict.
 */
export async function finalizeAgreement(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  config: Config,
): Promise<FinalizeResult> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    requireManage(access);

    if (access.agreement.status === 'ACTIVE' && access.agreement.final_version_id) {
      throw AppError.conflict('ALREADY_FINALIZED', 'This agreement is already finalized.');
    }
    if (access.agreement.status !== 'AWAITING_SIGNATURES') {
      throw AppError.conflict(
        'NOT_AWAITING_SIGNATURES',
        `Finalization requires AWAITING_SIGNATURES status (current: ${access.agreement.status}).`,
      );
    }

    // Never seal a document with missing required template information.
    await assertTemplateComplete(tx, agreementId);

    const versionId = access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version.');
    const version = await getVersion(tx, versionId);
    if (!version) throw AppError.notFound('Version not found.');

    const signers = await requiredSigners(tx, agreementId, versionId);
    const unsigned = signers.filter((s) => !s.has_signed);
    if (unsigned.length > 0) {
      throw AppError.conflict(
        'MISSING_SIGNATURES',
        `${unsigned.length} required signature(s) are still missing.`,
        { missing: unsigned.map((s) => ({ partyId: s.party_id, email: s.email })) },
      );
    }

    // Seal the version: status → FINAL (DB trigger freezes content afterwards).
    await exec(
      tx,
      `UPDATE agreement_versions SET status = 'FINAL', finalized_at = now() WHERE id = $1`,
      [versionId],
    );
    await exec(
      tx,
      `UPDATE agreements
       SET status = 'ACTIVE', final_version_id = $1, finalized_at = now()
       WHERE id = $2`,
      [versionId, agreementId],
    );

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'AGREEMENT_FINALIZED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        versionId,
        versionNumber: version.version_number,
        documentHash: version.document_hash,
        signatures: signers.length,
      },
      requestId: ctx.requestId,
    });

    // Initial verification record (integrity anchored at finalization).
    await exec(
      tx,
      `INSERT INTO verification_records (agreement_id, version_id, result, source, recomputed_hash)
       VALUES ($1,$2,'VERIFIED','SYSTEM',$3)`,
      [agreementId, versionId, version.document_hash],
    );

    // Document pipeline: HTML → PDF → hash → storage → verification.
    // The final PDF is generated once, here, inside the finalization
    // transaction, a finalized agreement without its immutable PDF simply
    // does not finalize. Stored outside the API's reach; downloads only go
    // through the authenticated document routes, which re-verify the hash.
    let pdfSha256: string | null = null;
    if (config.PDF_GENERATION === 'on') {
      const html = await buildDocumentHtml(tx, config, access.agreement, version);
      const hashShort = version.document_hash ? `${version.document_hash.slice(0, 8)}…` : '';
      const rendered = await renderPdf(config, {
        html,
        footerLeft: `${access.agreement.public_id} · v${version.version_number} · Final · SHA-256 ${hashShort}`,
      });
      const stored = await putDocumentPdf(
        config,
        documentPdfKey(access.agreement.public_id, version.version_number),
        rendered.bytes,
      );
      await exec(
        tx,
        `INSERT INTO generated_documents
           (agreement_id, version_id, storage_key, sha256, byte_size, engine)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (version_id) DO NOTHING`,
        [agreementId, versionId, stored.key, stored.sha256, stored.byteSize, rendered.engine],
      );
      await recordAudit(tx, {
        agreementId,
        orgId: access.agreement.org_id,
        eventType: 'DOCUMENT_GENERATED',
        actor: { type: 'SYSTEM', label: 'pdf-pipeline' },
        metadata: {
          publicId: access.agreement.public_id,
          versionId,
          versionNumber: version.version_number,
          format: 'PDF',
          sha256: stored.sha256,
          byteSize: stored.byteSize,
        },
        requestId: ctx.requestId,
      });
      pdfSha256 = stored.sha256;
    }

    await notifyParties(
      tx,
      agreementId,
      access.agreement.org_id,
      'AGREEMENT_FINALIZED',
      { publicId: access.agreement.public_id, title: access.agreement.title },
      ctx.userId,
    );

    const verificationUrl = `${webBaseUrl(config)}/verify/${access.agreement.public_id}`;
    return {
      finalized: true as const,
      publicId: access.agreement.public_id,
      versionId,
      versionNumber: version.version_number,
      documentHash: version.document_hash,
      verificationUrl,
      pdfSha256,
    };
  });
}
