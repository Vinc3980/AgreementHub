/**
 * Verification service (SPEC §14 + audit Phase 4).
 *
 * Three independent integrity checks are reported separately:
 *   1. canonical agreement content  → recomputed hash vs sealed document_hash
 *   2. finalized PDF bytes          → SHA-256 of the file on disk vs the
 *                                     hash registered with the final version
 *   3. signature records            → payload snapshot hash + the document hash
 *                                     each signer signed
 *
 * A caller-supplied `hash` (content) or `pdfHash` (PDF bytes) must match the
 * registered values; this is how a QR code carrying the PDF digest detects a
 * replaced/tampered PDF. Only public metadata is ever returned, never
 * agreement contents, parties, or comments.
 */
import {
  AppError,
  canonicalJson,
  computeDocumentHash,
  isValidPublicId,
  sha256Hex,
} from '@agreementhub/domain';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { exec, many, one, withTransaction } from '../db.js';
import { readDocumentPdf } from './storage.js';
import { recordAudit } from './audit.js';

export type VerificationResult = 'VERIFIED' | 'MISMATCH' | 'NOT_FOUND';
export type PdfIntegrity = 'VERIFIED' | 'MISMATCH' | 'NOT_AVAILABLE';
export type SignatureIntegrity = 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED' | 'NOT_AVAILABLE';
/**
 * Primary public-facing record state. `integrity`/component fields remain for
 * compatibility; `recordState` makes the distinction explicit:
 * - VALID: sealed evidence checks pass for available evidence and the record is
 *   not in a revoked/ended lifecycle state that would mislead users.
 * - MODIFIED: any integrity/hash mismatch or tampering signal detected.
 * - REVOKED: a sealed record exists but the agreement lifecycle ended
 *   (terminated, cancelled, rejected, or expired). Integrity is reported
 *   separately; this is not an authenticity claim about current enforceability.
 * - UNAVAILABLE: no matching record, not finalized/sealed, or required evidence
 *   is missing so integrity cannot be established.
 */
export type VerificationRecordState = 'VALID' | 'MODIFIED' | 'REVOKED' | 'UNAVAILABLE';

export interface VerificationResponse {
  agreementId: string;
  found: boolean;
  status: string | null;
  /** Primary state for UI/copy: valid, modified/tampered, revoked/lifecycle-ended, unavailable. */
  recordState: VerificationRecordState;
  /** Human-readable lifecycle context (metadata only). */
  lifecycleLabel: string | null;
  /** Plain explanation; never a legal/enforceability claim. */
  recordMessage: string;
  /** Template category label (safe metadata; never contents). */
  category: string | null;
  version: number | null;
  createdAt: string | null;
  finalizedAt: string | null;
  /** Overall verdict: MISMATCH if any check fails, otherwise VERIFIED. */
  integrity: VerificationResult;
  contentIntegrity: 'VERIFIED' | 'MISMATCH' | 'NOT_AVAILABLE';
  pdfIntegrity: PdfIntegrity;
  signatureIntegrity: SignatureIntegrity;
  signatures: { total: number; verified: number };
  /** Truncated digest for display. */
  hashPrefix: string | null;
  /** Full SHA-256 of the registered final PDF (a digest, never content). */
  pdfHash: string | null;
  pdfHashPrefix: string | null;
  /** Safe disclaimer shown by the UI. */
  disclaimer: string;
}

export interface VerifyInput {
  /** Public Agreement ID (AGR-GH-2026-000001). */
  agreementId: string;
  /** Optional full content hash supplied by a checker. */
  hash?: string;
  /** Optional full PDF-byte hash supplied by a checker / QR code. */
  pdfHash?: string;
  source?: 'QR' | 'URL' | 'API' | 'MANUAL';
  /** Hashed requester identity (never store raw IP here). */
  requesterHash?: string | null;
  /** Authenticated user for audit attribution; anonymous checks use SYSTEM. */
  actorId?: string | null;
  actorLabel?: string;
  requestId?: string;
}

const DISCLAIMER =
  'This check reports document integrity and lifecycle metadata only. It does not display agreement contents and does not constitute legal advice or proof of enforceability.';

const LIFECYCLE_ENDED = new Set(['EXPIRED', 'TERMINATED', 'CANCELLED', 'REJECTED']);

function lifecycleLabel(status: string | null): string | null {
  if (!status) return null;
  const labels: Record<string, string> = {
    DRAFT: 'Draft',
    REVIEW: 'Under review',
    NEGOTIATION: 'Negotiation',
    AWAITING_SIGNATURES: 'Awaiting signatures',
    ACTIVE: 'Active',
    EXPIRING: 'Expiring',
    EXPIRED: 'Expired',
    CANCELLED: 'Cancelled',
    TERMINATED: 'Terminated',
    REJECTED: 'Rejected',
  };
  return labels[status] ?? status.replace(/_/g, ' ').toLowerCase();
}

function unavailableResponse(agreementId: string, message: string): VerificationResponse {
  return {
    agreementId,
    found: false,
    status: null,
    recordState: 'UNAVAILABLE',
    lifecycleLabel: null,
    recordMessage: message,
    category: null,
    version: null,
    createdAt: null,
    finalizedAt: null,
    integrity: 'NOT_FOUND',
    contentIntegrity: 'NOT_AVAILABLE',
    pdfIntegrity: 'NOT_AVAILABLE',
    signatureIntegrity: 'NOT_AVAILABLE',
    signatures: { total: 0, verified: 0 },
    hashPrefix: null,
    pdfHash: null,
    pdfHashPrefix: null,
    disclaimer: DISCLAIMER,
  };
}

export async function verifyAgreement(
  db: Db,
  input: VerifyInput,
  config: Config,
): Promise<VerificationResponse> {
  if (!isValidPublicId(input.agreementId)) {
    return unavailableResponse(
      input.agreementId,
      'No matching agreement record was found for this reference. Check the ID and try again.',
    );
  }

  return withTransaction(db, async (tx) => {
    const agreement = await one<{
      id: string;
      public_id: string;
      status: string;
      category_label: string | null;
      final_version_id: string | null;
      created_at: Date;
      finalized_at: Date | null;
      org_id: string;
    }>(
      tx,
      `SELECT a.id, a.public_id, a.status, c.label AS category_label,
              a.final_version_id, a.created_at, a.finalized_at, a.org_id
       FROM agreements a
       LEFT JOIN template_categories c ON c.id = a.category_id
       WHERE a.public_id = $1 AND a.deleted_at IS NULL`,
      [input.agreementId],
    );

    if (!agreement) {
      await exec(
        tx,
        `INSERT INTO verification_records (agreement_id, result, source, requester_hash)
         VALUES (NULL, 'NOT_FOUND', $1, $2)`,
        [input.source ?? 'URL', input.requesterHash ?? null],
      );
      return unavailableResponse(
        input.agreementId,
        'No matching agreement record was found for this reference. A reference alone does not confirm authenticity.',
      );
    }

    if (!agreement.final_version_id) {
      // Not yet finalized: nothing sealed to verify. Report honestly.
      const label = lifecycleLabel(agreement.status);
      const response: VerificationResponse = {
        agreementId: agreement.public_id,
        found: true,
        status: agreement.status,
        recordState: 'UNAVAILABLE',
        lifecycleLabel: label,
        recordMessage:
          `This agreement exists${label ? ` (${label})` : ''} but it has not been finalized and sealed. Integrity verification applies to the finalized PDF and version record.`,
        category: agreement.category_label,
        version: null,
        createdAt: agreement.created_at.toISOString(),
        finalizedAt: null,
        integrity: 'NOT_FOUND',
        contentIntegrity: 'NOT_AVAILABLE',
        pdfIntegrity: 'NOT_AVAILABLE',
        signatureIntegrity: 'NOT_AVAILABLE',
        signatures: { total: 0, verified: 0 },
        hashPrefix: null,
        pdfHash: null,
        pdfHashPrefix: null,
        disclaimer: DISCLAIMER,
      };
      await recordAudit(tx, {
        agreementId: agreement.id,
        orgId: agreement.org_id,
        eventType: 'DOCUMENT_VERIFIED',
        actor: {
          type: input.actorId ? 'USER' : 'SYSTEM',
          id: input.actorId ?? null,
          label: input.actorLabel ?? 'anonymous',
        },
        metadata: {
          publicId: agreement.public_id,
          result: 'NOT_FOUND',
          recordState: 'UNAVAILABLE',
          status: agreement.status,
          reason: 'not_finalized',
          source: input.source ?? 'URL',
        },
        requestId: input.requestId ?? null,
      });
      return response;
    }

    const version = await one<{
      version_number: number;
      content: unknown;
      document_hash: string;
      finalized_at: Date | null;
    }>(
      tx,
      `SELECT version_number, content, document_hash, finalized_at
       FROM agreement_versions WHERE id = $1`,
      [agreement.final_version_id],
    );
    if (!version) {
      throw AppError.internal('Final version row missing for finalized agreement.');
    }

    // 1) Canonical content integrity.
    const recomputed = computeDocumentHash(
      version.content as Parameters<typeof computeDocumentHash>[0],
    );
    let contentIntegrity: 'VERIFIED' | 'MISMATCH' =
      recomputed === version.document_hash ? 'VERIFIED' : 'MISMATCH';
    if (input.hash && input.hash !== version.document_hash) contentIntegrity = 'MISMATCH';

    // 2) Finalized PDF bytes integrity.
    const document = await one<{ storage_key: string; sha256: string }>(
      tx,
      `SELECT storage_key, sha256 FROM generated_documents WHERE version_id = $1`,
      [agreement.final_version_id],
    );
    let pdfIntegrity: PdfIntegrity = 'NOT_AVAILABLE';
    let pdfHash: string | null = null;
    let pdfMissing = false;
    if (document) {
      pdfHash = document.sha256;
      const file = await readDocumentPdf(config, document.storage_key);
      if (!file) {
        pdfIntegrity = 'NOT_AVAILABLE';
        pdfMissing = true;
      } else {
        pdfIntegrity = file.sha256 === document.sha256 ? 'VERIFIED' : 'MISMATCH';
      }
      // A checker that knows the PDF digest must agree with the registered one.
      if (input.pdfHash && input.pdfHash !== document.sha256) pdfIntegrity = 'MISMATCH';
    }

    // 3) Signature records integrity (exact final version only).
    const signatures = await many<{
      document_hash_at_signing: string;
      signature_payload_hash: string;
      payload_snapshot: Record<string, unknown> | null;
    }>(
      tx,
      `SELECT document_hash_at_signing, signature_payload_hash, payload_snapshot
       FROM signatures WHERE version_id = $1`,
      [agreement.final_version_id],
    );
    let signatureIntegrity: SignatureIntegrity =
      signatures.length === 0 ? 'NOT_AVAILABLE' : 'VERIFIED';
    let verifiedSignatures = 0;
    for (const signature of signatures) {
      if (signature.document_hash_at_signing !== version.document_hash) {
        signatureIntegrity = 'MISMATCH';
        continue;
      }
      if (!signature.payload_snapshot) {
        // Legacy record created before payload snapshots existed: honest
        // "unverified" rather than a false pass (or a false tamper alarm).
        if (signatureIntegrity === 'VERIFIED') signatureIntegrity = 'UNVERIFIED';
        continue;
      }
      const recomputedPayload = sha256Hex(canonicalJson(signature.payload_snapshot));
      if (recomputedPayload !== signature.signature_payload_hash) {
        signatureIntegrity = 'MISMATCH';
        continue;
      }
      verifiedSignatures += 1;
    }

    const integrity: VerificationResult =
      contentIntegrity === 'MISMATCH' ||
      pdfIntegrity === 'MISMATCH' ||
      signatureIntegrity === 'MISMATCH'
        ? 'MISMATCH'
        : 'VERIFIED';

    const label = lifecycleLabel(agreement.status);
    const ended = LIFECYCLE_ENDED.has(agreement.status);
    let recordState: VerificationRecordState;
    let recordMessage: string;
    if (integrity === 'MISMATCH') {
      recordState = 'MODIFIED';
      recordMessage =
        'This record did not pass integrity verification. The presented or stored evidence does not match the sealed record and may have been modified or replaced.';
    } else if (ended) {
      recordState = 'REVOKED';
      recordMessage =
        `The sealed record's available integrity checks passed, but the agreement lifecycle is ${label ?? agreement.status.toLowerCase()}. This is not a claim that the agreement is currently in force or legally effective.`;
    } else {
      recordState = 'VALID';
      if (pdfIntegrity === 'NOT_AVAILABLE' || signatureIntegrity === 'UNVERIFIED') {
        recordMessage =
          'Available integrity checks for the sealed record passed. Some supporting evidence is unavailable or could not be fully verified; review the checklist details below.';
      } else {
        recordMessage =
          'The sealed record matches the registered integrity evidence. This confirms document integrity only, not legal advice or enforceability.';
      }
    }
    if (pdfMissing && recordState !== 'MODIFIED') {
      recordMessage += ' The finalized PDF file is unavailable, so PDF-byte integrity could not be checked.';
    }

    await exec(
      tx,
      `INSERT INTO verification_records
         (agreement_id, version_id, result, source, requester_hash, recomputed_hash,
          pdf_hash, content_result, pdf_result, signature_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        agreement.id,
        agreement.final_version_id,
        integrity,
        input.source ?? 'URL',
        input.requesterHash ?? null,
        recomputed,
        pdfHash,
        contentIntegrity,
        pdfIntegrity,
        signatureIntegrity,
      ],
    );

    await recordAudit(tx, {
      agreementId: agreement.id,
      orgId: agreement.org_id,
      eventType: 'DOCUMENT_VERIFIED',
      actor: {
        type: input.actorId ? 'USER' : 'SYSTEM',
        id: input.actorId ?? null,
        label: input.actorLabel ?? 'anonymous',
      },
      metadata: {
        publicId: agreement.public_id,
        result: integrity,
        recordState,
        status: agreement.status,
        versionId: agreement.final_version_id,
        versionNumber: version.version_number,
        source: input.source ?? 'URL',
        contentResult: contentIntegrity,
        pdfResult: pdfIntegrity,
        signatureResult: signatureIntegrity,
        recomputedHash: recomputed,
        storedHash: version.document_hash,
      },
      requestId: input.requestId ?? null,
    });

    return {
      agreementId: agreement.public_id,
      found: true,
      status: agreement.status,
      recordState,
      lifecycleLabel: label,
      recordMessage,
      category: agreement.category_label,
      version: version.version_number,
      createdAt: agreement.created_at.toISOString(),
      finalizedAt: (version.finalized_at ?? agreement.finalized_at)?.toISOString() ?? null,
      integrity,
      contentIntegrity,
      pdfIntegrity,
      signatureIntegrity,
      signatures: { total: signatures.length, verified: verifiedSignatures },
      hashPrefix: version.document_hash.slice(0, 12),
      pdfHash,
      pdfHashPrefix: pdfHash ? pdfHash.slice(0, 12) : null,
      disclaimer: DISCLAIMER,
    };
  });
}
