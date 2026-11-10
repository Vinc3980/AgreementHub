/**
 * /verification routes (SPEC §14).
 *
 * GET  /verification/:publicId: PUBLIC verification page data (no auth).
 *    Exposes only: Agreement ID, status, version, dates, integrity status.
 *    Never exposes contents, parties, comments, or internal audit data.
 * POST /verification: authenticated verification with optional
 *    caller-supplied hash (used by API clients / QR scanners with hash).
 *
 * Both endpoints are rate-limited and every check is recorded.
 */
import type { FastifyInstance } from 'fastify';
import { verifyRequestSchema } from '@agreementhub/contracts';
import { sha256Hex } from '@agreementhub/domain';
import { authenticate, maybeAuthenticate } from '../plugins/auth.js';
import { verifyAgreement } from '../services/verification.js';

export function registerVerificationRoutes(app: FastifyInstance): void {
  const { ahDb: db, ahConfig: config } = app;

  const verifyRateLimit = {
    rateLimit: { max: 60, timeWindow: config.RATE_LIMIT_WINDOW_MS },
  };

  // PUBLIC: no authentication. Used by the QR code target page.
  app.get(
    '/verification/:publicId',
    { preHandler: maybeAuthenticate, config: verifyRateLimit },
    async (request) => {
      const { publicId } = request.params as { publicId: string };
      const query = request.query as { pdfHash?: string };
      const pdfHash =
        typeof query.pdfHash === 'string' && /^[0-9a-f]{64}$/.test(query.pdfHash)
          ? query.pdfHash
          : undefined;
      const result = await verifyAgreement(
        db,
        {
          agreementId: publicId.toUpperCase(),
          pdfHash,
          source: pdfHash ? 'QR' : 'URL',
          requesterHash: requesterHash(request.ip),
          actorId: request.actor?.userId ?? null,
          actorLabel: request.actor?.email ?? 'anonymous',
          requestId: String(request.id),
        },
        config,
      );
      // Public projection: metadata + integrity/lifecycle signals only, never contents.
      // Includes recordState/message so the public UI can distinguish valid, modified,
      // unavailable, and lifecycle-ended (revoked) records without exposing contents.
      return {
        agreementId: result.agreementId,
        found: result.found,
        status: result.status,
        recordState: result.recordState,
        lifecycleLabel: result.lifecycleLabel,
        recordMessage: result.recordMessage,
        category: result.category,
        version: result.version,
        createdAt: result.createdAt,
        finalizedAt: result.finalizedAt,
        integrity: result.integrity,
        contentIntegrity: result.contentIntegrity,
        pdfIntegrity: result.pdfIntegrity,
        signatureIntegrity: result.signatureIntegrity,
        signatures: result.signatures,
        hashPrefix: result.hashPrefix,
        pdfHash: result.pdfHash,
        pdfHashPrefix: result.pdfHashPrefix,
        disclaimer: result.disclaimer,
      };
    },
  );

  // Authenticated: same projection + optional full-hash comparison.
  app.post(
    '/verification',
    { preHandler: authenticate, config: verifyRateLimit },
    async (request) => {
      const input = verifyRequestSchema.parse(request.body);
      return verifyAgreement(
        db,
        {
          agreementId: input.agreementId,
          hash: input.hash,
          pdfHash: input.pdfHash,
          source: 'API',
          requesterHash: requesterHash(request.ip),
          actorId: request.actor?.userId ?? null,
          actorLabel: request.actor?.email,
          requestId: String(request.id),
        },
        config,
      );
    },
  );
}

/** Hash IPs before persistence, raw IPs are never stored on records. */
function requesterHash(ip: string): string {
  return sha256Hex(`verify:${ip}`);
}
