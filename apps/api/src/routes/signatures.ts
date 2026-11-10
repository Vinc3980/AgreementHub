/**
 * /signatures routes: request signatures, record signature, finalize,
 * list signature status.
 */
import type { FastifyInstance } from 'fastify';
import {
  recordSignatureRequestSchema,
  requestSignatureRequestSchema,
} from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { many } from '../db.js';
import { getAgreement } from '../services/agreements.js';
import { requireAccess } from '../services/access.js';
import {
  finalizeAgreement,
  recordSignature,
  requestSignature,
} from '../services/signatures.js';
import { requestSignatureOtp } from '../services/signatureOtp.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerSignatureRoutes(app: FastifyInstance): void {
  const { ahDb: db, ahConfig: config } = app;

  app.post('/signatures/request', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const input = requestSignatureRequestSchema.parse(request.body);
    return requestSignature(db, ctx, {
      agreementId: input.agreementId,
      versionId: input.versionId,
      message: input.message,
    });
  });

  app.post('/signatures', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const input = recordSignatureRequestSchema.parse(request.body);
    const result = await recordSignature(db, ctx, {
      agreementId: input.agreementId,
      consent: true,
      signatureText: input.signatureText,
      signatureData: input.signatureData,
      method: input.method,
      otpCode: input.otpCode,
    });
    return reply.status(201).send({
      signature: {
        id: result.signature.id,
        versionId: result.signature.version_id,
        signedAt: result.signature.signed_at.toISOString(),
        method: result.signature.method,
        identityAssurance: result.signature.identity_assurance,
        documentHashAtSigning: result.signature.document_hash_at_signing,
        signaturePayloadHash: result.signature.signature_payload_hash,
        consentTextVersion: result.signature.consent_text_version,
      },
      allSigned: result.complete,
      missingSignatures: result.missing,
    });
  });

  // EMAIL_OTP: request a code for the caller's current version. The code is
  // emailed (never returned by the API) and consumed by POST /signatures.
  app.post('/signatures/otp', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { agreementId } = request.body as { agreementId?: string };
    if (!agreementId || typeof agreementId !== 'string') {
      throw AppError.badRequest('AGREEMENT_REQUIRED', 'agreementId is required.');
    }
    const result = await requestSignatureOtp(db, ctx, agreementId);
    return {
      ok: true,
      sentTo: result.sentTo,
      expiresAt: result.expiresAt.toISOString(),
      expiresMinutes: 10,
    };
  });

  app.post('/agreements/:id/finalize', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const result = await finalizeAgreement(db, ctx, id, config);
    return result;
  });

  app.get('/agreements/:id/signatures', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const access = await requireAccess(db, ctx.userId, ctx.email, id);
    const rows = await many(
      db,
      `SELECT s.id, s.version_id, s.signer_email, s.method, s.identity_assurance, s.signed_at,
              s.document_hash_at_signing, s.signature_payload_hash, s.consent_text_version,
              p.role AS party_role
       FROM signatures s
       JOIN agreement_parties p ON p.id = s.party_id
       WHERE s.agreement_id = $1
       ORDER BY s.signed_at ASC`,
      [access.agreement.id],
    );
    return {
      status: access.agreement.status,
      currentVersionId: access.agreement.current_version_id,
      finalVersionId: access.agreement.final_version_id,
      signatures: rows.map((r) => ({
        id: r.id,
        versionId: r.version_id,
        signerEmail: r.signer_email,
        partyRole: r.party_role,
        method: r.method,
        identityAssurance: r.identity_assurance,
        signedAt:
          r.signed_at instanceof Date ? r.signed_at.toISOString() : String(r.signed_at),
        documentHashAtSigning: r.document_hash_at_signing,
        consentTextVersion: r.consent_text_version,
      })),
    };
  });

  // Convenience alias kept for API symmetry: signature status without detail.
  app.get('/agreements/:id/signature-status', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const detail = await getAgreement(db, ctx, id);
    const rows = await many<{ total: number; signed: number }>(
      db,
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE s.id IS NOT NULL)::int AS signed
       FROM agreement_parties p
       JOIN agreements a ON a.id = p.agreement_id
       LEFT JOIN signatures s ON s.party_id = p.id AND s.version_id = a.current_version_id
       WHERE p.agreement_id = $1 AND p.role IN ('OWNER','SIGNER') AND p.status <> 'DECLINED'`,
      [id],
    );
    return {
      status: detail.agreement.status,
      versionId: detail.agreement.current_version_id,
      required: rows[0]?.total ?? 0,
      signed: rows[0]?.signed ?? 0,
    };
  });
}
