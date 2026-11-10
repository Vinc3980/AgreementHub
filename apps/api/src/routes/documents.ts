/**
 * /documents routes: HTML download, on-screen preview, PDF download, and
 * audit CSV export (SPEC §14, document pipeline).
 *
 * Downloads re-render from the stored version snapshot and record a
 * DOCUMENT_DOWNLOADED audit event (FR-10.6). The PDF pipeline's storage is
 * private: no storage path or URL is ever returned to clients, bytes are
 * streamed only through these authenticated, access-checked routes, and
 * stored final PDFs are re-verified against their recorded hash on every
 * single download.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, auditEventCategory } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { exec, many, one, withTransaction } from '../db.js';
import { requireAccess, type AgreementAccess } from '../services/access.js';
import { auditActor, type ActorContext } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import {
  buildDocumentHtml,
  loadRenderableVersion,
  type RenderableVersion,
} from '../services/documentHtml.js';
import { renderPdf } from '../services/pdf.js';
import { documentPdfKey, putDocumentPdf, readDocumentPdf } from '../services/storage.js';

type DocumentFormat = 'html' | 'preview' | 'pdf';

export function registerDocumentRoutes(app: FastifyInstance): void {
  const { ahDb: db, ahConfig: config } = app;

  /** Validate the version-number param and load the version snapshot. */
  async function loadVersion(
    access: AgreementAccess,
    versionNumber: string,
  ): Promise<RenderableVersion> {
    const versionNo = Number(versionNumber);
    if (!Number.isInteger(versionNo) || versionNo < 1) {
      throw AppError.badRequest('BAD_VERSION', 'Version number must be a positive integer.');
    }
    const version = await loadRenderableVersion(db, access.agreement.id, versionNo);
    if (!version) throw AppError.notFound('Version not found.');
    return version;
  }

  /** Append-only audit event for every document access. */
  async function auditDocumentAccess(
    ctx: ActorContext,
    access: AgreementAccess,
    version: RenderableVersion,
    format: DocumentFormat,
    source: 'rendered' | 'stored' | 'generated',
  ): Promise<void> {
    await withTransaction(db, async (tx) => {
      await recordAudit(tx, {
        agreementId: access.agreement.id,
        orgId: access.agreement.org_id,
        eventType: 'DOCUMENT_DOWNLOADED',
        actor: auditActor(ctx),
        metadata: {
          publicId: access.agreement.public_id,
          versionId: version.id,
          versionNumber: version.version_number,
          format,
          source,
          documentHash: version.document_hash,
        },
        requestId: ctx.requestId,
      });
    });
  }

  /**
   * Serve the stored PDF of a version, refusing anything whose bytes no
   * longer match the recorded hash (tamper detection).
   */
  async function serveStoredPdf(
    access: AgreementAccess,
    version: RenderableVersion,
  ): Promise<{ bytes: Buffer; sha256: string }> {
    const row = await one<{ storage_key: string; sha256: string }>(
      db,
      `SELECT storage_key, sha256 FROM generated_documents WHERE version_id = $1`,
      [version.id],
    );
    if (!row) {
      throw AppError.internal('Generated document record is missing.');
    }
    const file = await readDocumentPdf(config, row.storage_key);
    if (!file) {
      throw AppError.conflict(
        'DOCUMENT_STORAGE_MISSING',
        'The stored document is missing from server storage and cannot be served.',
      );
    }
    if (file.sha256 !== row.sha256) {
      // Never serve, or silently regenerate, a finalized document whose
      // bytes diverge from the hash recorded at finalization.
      throw AppError.conflict(
        'DOCUMENT_HASH_MISMATCH',
        'The stored document failed its integrity check against the hash recorded at finalization.',
      );
    }
    return { bytes: file.bytes, sha256: row.sha256 };
  }

  /** Render the version to HTML (shared by download + preview). */
  async function renderHtml(access: AgreementAccess, version: RenderableVersion) {
    return buildDocumentHtml(db, config, access.agreement, version);
  }

  /* ------------------------------ HTML download ------------------------ */
  app.get(
    '/agreements/:id/documents/:versionNumber/download',
    { preHandler: authenticate },
    async (request, reply) => {
      const ctx = request.actor!;
      const { id, versionNumber } = request.params as { id: string; versionNumber: string };
      const access = await requireAccess(db, ctx.userId, ctx.email, id);
      const version = await loadVersion(access, versionNumber);

      const html = await renderHtml(access, version);

      // FR-10.6: every download is an audited event on the chain.
      await auditDocumentAccess(ctx, access, version, 'html', 'rendered');

      const filename = `${access.agreement.public_id}-v${version.version_number}.html`;
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(html);
    },
  );

  /* --------------------------------- Preview -------------------------- */
  // In-app document preview (drafts are labelled DRAFT: NOT FINAL by the
  // renderer; finalized documents are labelled FINAL AGREEMENT). Same bytes
  // as the download, previewing cannot change what the document says.
  app.get(
    '/agreements/:id/documents/:versionNumber/preview',
    { preHandler: authenticate },
    async (request, reply) => {
      const ctx = request.actor!;
      const { id, versionNumber } = request.params as { id: string; versionNumber: string };
      const access = await requireAccess(db, ctx.userId, ctx.email, id);
      const version = await loadVersion(access, versionNumber);

      const html = await renderHtml(access, version);
      await auditDocumentAccess(ctx, access, version, 'preview', 'rendered');

      const filename = `${access.agreement.public_id}-v${version.version_number}.html`;
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-disposition', `inline; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(html);
    },
  );

  /* ---------------------------------- PDF ----------------------------- */
  // Controlled download: authenticated + access-checked, streamed from
  // private storage. Finalized versions are served from their immutable
  // stored PDF (hash-verified, never regenerated); drafts are rendered
  // ephemerally with the DRAFT: NOT FINAL label.
  app.get(
    '/agreements/:id/documents/:versionNumber/pdf',
    { preHandler: authenticate },
    async (request, reply) => {
      const ctx = request.actor!;
      const { id, versionNumber } = request.params as { id: string; versionNumber: string };
      const access = await requireAccess(db, ctx.userId, ctx.email, id);
      const version = await loadVersion(access, versionNumber);

      const existing = await one<{ storage_key: string; sha256: string }>(
        db,
        `SELECT storage_key, sha256 FROM generated_documents WHERE version_id = $1`,
        [version.id],
      );

      let bytes: Buffer;
      let source: 'stored' | 'generated';

      if (existing) {
        ({ bytes } = await serveStoredPdf(access, version));
        source = 'stored';
      } else if (config.PDF_GENERATION === 'on') {
        const html = await renderHtml(access, version);
        const hashShort = version.document_hash ? `${version.document_hash.slice(0, 8)}…` : '';
        const statusLabel = version.status === 'FINAL' ? 'Final' : 'Draft';
        const rendered = await renderPdf(config, {
          html,
          footerLeft: `${access.agreement.public_id} · v${version.version_number} · ${statusLabel} · SHA-256 ${hashShort}`,
        });

        if (version.status === 'FINAL') {
          // Backfill for versions finalized before the pipeline existed:
          // persist once (write-once, later calls keep these bytes) and
          // serve through the verified stored path from then on.
          const persisted = await putDocumentPdf(
            config,
            documentPdfKey(access.agreement.public_id, version.version_number),
            rendered.bytes,
          );
          await exec(
            db,
            `INSERT INTO generated_documents
               (agreement_id, version_id, storage_key, sha256, byte_size, engine)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (version_id) DO NOTHING`,
            [
              access.agreement.id,
              version.id,
              persisted.key,
              persisted.sha256,
              persisted.byteSize,
              rendered.engine,
            ],
          );
          ({ bytes } = await serveStoredPdf(access, version));
          source = 'stored';
        } else {
          // Drafts are ephemeral: rendered on demand, never persisted, so
          // the PDF system can never write over a finalized document.
          bytes = rendered.bytes;
          source = 'generated';
        }
      } else {
        throw new AppError(
          503,
          'PDF_UNAVAILABLE',
          'PDF generation is disabled on this server (PDF_GENERATION=off) and this version has no stored PDF.',
        );
      }

      await auditDocumentAccess(ctx, access, version, 'pdf', source);

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const filename = `${access.agreement.public_id}-v${version.version_number}.pdf`;
      return reply
        .header('content-type', 'application/pdf')
        .header('content-length', String(bytes.length))
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .header('x-document-sha256', sha256)
        .send(bytes);
    },
  );

  /* --------------------------- audit CSV export ------------------------ */
  app.get('/agreements/:id/audit/export', { preHandler: authenticate }, async (request, reply) => {
    const ctx = request.actor!;
    const { id } = request.params as { id: string };
    const access = await requireAccess(db, ctx.userId, ctx.email, id);

    const rows = await many<{
      seq: string | null;
      event_type: string;
      actor_type: string;
      actor_label: string;
      occurred_at: Date;
      request_id: string | null;
      event_hash: string;
      metadata: Record<string, unknown>;
    }>(
      db,
      `SELECT seq, event_type, actor_type, actor_label, occurred_at, request_id, event_hash, metadata
       FROM audit_events WHERE agreement_id = $1 ORDER BY seq ASC NULLS LAST`,
      [access.agreement.id],
    );

    const csvEscape = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['seq', 'event_type', 'category', 'actor_type', 'actor_label', 'occurred_at', 'request_id', 'event_hash', 'metadata']
        .join(','),
      ...rows.map((r) =>
        [
          r.seq ?? '',
          csvEscape(r.event_type),
          csvEscape(auditEventCategory(r.event_type, r.actor_type)),
          csvEscape(r.actor_type),
          csvEscape(r.actor_label),
          csvEscape(r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at),
          csvEscape(r.request_id ?? ''),
          r.event_hash,
          csvEscape(JSON.stringify(r.metadata)),
        ].join(','),
      ),
    ];

    const filename = `${access.agreement.public_id}-audit.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-content-type-options', 'nosniff')
      .send(lines.join('\r\n'));
  });
}
