/**
 * /agreements routes: create, list, retrieve, update draft, status
 * transitions, cancel, terminate.
 */
import type { FastifyInstance } from 'fastify';
import {
  agreementListQuerySchema,
  createAgreementRequestSchema,
  transitionRequestSchema,
  updateDraftRequestSchema,
} from '@agreementhub/contracts';
import { AppError, auditEventCategory, type AgreementStatus } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { many } from '../db.js';
import {
  cancelAgreement,
  createAgreement,
  getAgreement,
  startAmendment,
  terminateAgreement,
  transitionAgreement,
  updateDraft,
} from '../services/agreements.js';
import { recordPartyView } from '../services/parties.js';
import { listVersions } from '../services/versions.js';
import { verifyAuditChain } from '../services/audit.js';
import { sendSignatureReminder } from '../services/scheduler.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext; id: unknown }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerAgreementRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  /* ------------------------------- create ------------------------------ */
  app.post('/agreements', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const input = createAgreementRequestSchema.parse(request.body);
    const { agreement, version } = await createAgreement(db, ctx, input);
    return reply.status(201).send({
      agreement: publicAgreement(agreement),
      initialVersion: {
        id: version.id,
        versionNumber: version.version_number,
        documentHash: version.document_hash,
        status: version.status,
      },
    });
  });

  /* -------------------------------- list ------------------------------- */
  app.get('/agreements', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const query = agreementListQuerySchema.parse(request.query);

    // Cursor encodes `updated_at:id` for stable keyset pagination.
    let cursorTs: string | null = null;
    let cursorId: string | null = null;
    if (query.cursor) {
      const sep = query.cursor.lastIndexOf(':');
      cursorTs = query.cursor.slice(0, sep);
      cursorId = query.cursor.slice(sep + 1);
      if (sep < 0 || Number.isNaN(Date.parse(cursorTs)) || !/^[0-9a-f-]{36}$/i.test(cursorId)) {
        throw AppError.badRequest('BAD_CURSOR', 'Malformed pagination cursor.');
      }
    }

    // Visible = agreements in the user's active orgs (role-gated), plus
    // agreements where the user is a party (external counterparties).
    const rows = await many<{
      id: string;
      public_id: string;
      title: string;
      status: string;
      org_id: string;
      category_code: string;
      created_at: Date;
      updated_at: Date;
      expires_at: Date | null;
      finalized_at: Date | null;
      my_role: string | null;
    }>(
      db,
      `SELECT a.id, a.public_id, a.title, a.status, a.org_id,
              c.code AS category_code, a.created_at, a.updated_at,
              a.expires_at, a.finalized_at,
              (SELECT rp.role FROM agreement_parties rp
               WHERE rp.agreement_id = a.id AND rp.user_id = $1 LIMIT 1) AS my_role
       FROM agreements a
       JOIN template_categories c ON c.id = a.category_id
       WHERE a.deleted_at IS NULL
         AND (
           EXISTS (SELECT 1 FROM organization_members m
                   WHERE m.org_id = a.org_id AND m.user_id = $1 AND m.status = 'ACTIVE'
                     AND (m.role <> 'MEMBER'
                          OR EXISTS (SELECT 1 FROM agreement_parties p
                                     WHERE p.agreement_id = a.id AND p.user_id = $1)))
           OR EXISTS (SELECT 1 FROM agreement_parties p
                      WHERE p.agreement_id = a.id AND p.user_id = $1)
         )
         AND ($2::text IS NULL OR a.status = $2)
         AND ($3::text IS NULL OR c.code = $3)
         AND ($4::text IS NULL OR a.title ILIKE '%' || $4 || '%' OR a.public_id ILIKE '%' || $4 || '%')
         AND ($5::timestamptz IS NULL
              OR a.updated_at < $5::timestamptz
              OR (a.updated_at = $5::timestamptz AND a.id < $6::uuid))
         AND ($8::timestamptz IS NULL OR a.created_at >= $8::timestamptz)
         AND ($9::timestamptz IS NULL OR a.created_at <= $9::timestamptz)
         AND ($10::text IS NULL
              OR EXISTS (SELECT 1 FROM agreement_parties rp
                         WHERE rp.agreement_id = a.id AND rp.user_id = $1 AND rp.role = $10))
       ORDER BY a.updated_at DESC, a.id DESC
       LIMIT $7`,
      [
        ctx.userId,
        query.status ?? null,
        query.category ?? null,
        query.q ?? null,
        cursorTs,
        cursorId ?? '00000000-0000-0000-0000-000000000000',
        query.limit,
        query.dateFrom ?? null,
        query.dateTo ?? null,
        query.role ?? null,
      ],
    );

    const last = rows[rows.length - 1];
    return {
      agreements: rows.map((r) => ({
        id: r.id,
        publicId: r.public_id,
        title: r.title,
        status: r.status,
        categoryCode: r.category_code,
        myRole: r.my_role,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        expiresAt: r.expires_at?.toISOString() ?? null,
        finalizedAt: r.finalized_at?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length === query.limit && last
          ? `${last.updated_at.toISOString()}:${last.id}`
          : null,
    };
  });

  /* ------------------------------ retrieve ----------------------------- */
  app.get('/agreements/:id', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const detail = await getAgreement(db, ctx, id);
    await recordPartyView(db, ctx, id);
    return serializeDetail(detail);
  });

  /* ---------------------------- update draft --------------------------- */
  app.patch('/agreements/:id', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = updateDraftRequestSchema.parse(request.body);
    const detail = await updateDraft(db, ctx, id, input);
    return serializeDetail(detail);
  });

  /* ------------------------------- versions ---------------------------- */
  app.get('/agreements/:id/versions', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    // Access check happens through getAgreement; list needs visibility too.
    await getAgreement(db, ctx, id);
    const versions = await listVersions(db, id);
    return {
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        status: v.status,
        changeSummary: v.change_summary,
        documentHash: v.document_hash,
        previousVersionId: v.previous_version_id,
        createdBy: v.created_by,
        createdAt: v.created_at.toISOString(),
        finalizedAt: v.finalized_at?.toISOString() ?? null,
      })),
    };
  });

  /* --------------------------- status transition ----------------------- */
  app.post('/agreements/:id/status', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = transitionRequestSchema.parse(request.body);
    const updated = await transitionAgreement(
      db,
      ctx,
      id,
      input.to as AgreementStatus,
      input.reason,
    );
    return { agreement: publicAgreement(updated) };
  });

  /* --------------------------- cancel / terminate ---------------------- */
  app.post('/agreements/:id/cancel', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const { reason } = requireReason(request.body);
    const updated = await cancelAgreement(db, ctx, id, reason);
    return { agreement: publicAgreement(updated) };
  });

  app.post('/agreements/:id/terminate', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const { reason } = requireReason(request.body);
    const updated = await terminateAgreement(db, ctx, id, reason);
    return { agreement: publicAgreement(updated) };
  });

  /* ---------------------------- amendment ----------------------------- */
  // Post-finalization changes: seeds a new working version from the sealed
  // final document and re-opens negotiation. The final version stays FINAL.
  app.post('/agreements/:id/amendments', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const result = await startAmendment(db, ctx, id);
    return reply.status(201).send({
      agreement: publicAgreement(result.agreement),
      version: {
        id: result.version.id,
        versionNumber: result.version.version_number,
        status: result.version.status,
        changeSummary: result.version.change_summary,
        documentHash: result.version.document_hash,
        createdAt: result.version.created_at.toISOString(),
      },
      finalVersionNumber: result.finalVersionNumber,
    });
  });

  /* --------------------------- manual reminders ----------------------- */
  // Owner-facing "send reminder" action. Throttled to one per signer/hour.
  app.post('/agreements/:id/remind', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { partyId?: unknown };
    const partyId =
      typeof body.partyId === 'string' && /^[0-9a-f-]{36}$/i.test(body.partyId)
        ? body.partyId
        : undefined;
    if (body.partyId !== undefined && !partyId) {
      throw AppError.badRequest('INVALID_PARTY', 'partyId must be a UUID.');
    }
    return sendSignatureReminder(db, ctx, id, partyId);
  });

  /* --------------------------- audit timeline -------------------------- */
  app.get('/agreements/:id/audit', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    await getAgreement(db, ctx, id); // visibility check
    const rows = await many(
      db,
      `SELECT seq, event_type, actor_type, actor_label, metadata, request_id, occurred_at, event_hash
       FROM audit_events WHERE agreement_id = $1
       ORDER BY seq ASC
       LIMIT 500`,
      [id],
    );
    // Walk the full hash chain; a break means tampering (should never happen;
    // triggers block UPDATE/DELETE, but the UI must be able to say so).
    let chainVerified = true;
    let verifiedEvents = 0;
    try {
      verifiedEvents = await verifyAuditChain(db, id);
    } catch {
      chainVerified = false;
    }
    return {
      events: rows.map((r) => ({
        seq: r.seq === null ? null : Number(r.seq),
        eventType: r.event_type,
        // User activity / agreement events / system events (SPEC §11.3).
        category: auditEventCategory(r.event_type, r.actor_type),
        actorType: r.actor_type,
        actorLabel: r.actor_label,
        metadata: r.metadata,
        requestId: r.request_id,
        occurredAt:
          r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
        eventHash: r.event_hash,
      })),
      chainVerified,
      verifiedEvents,
    };
  });
}

function requireReason(body: unknown): { reason: string } {
  const reason = (body as { reason?: string })?.reason?.trim();
  if (!reason || reason.length < 3) {
    throw AppError.badRequest('REASON_REQUIRED', 'A reason (3–1000 chars) is required.');
  }
  if (reason.length > 1000) {
    throw AppError.badRequest('REASON_TOO_LONG', 'Reason must be 1000 characters or fewer.');
  }
  return { reason };
}

function publicAgreement(a: {
  id: string;
  public_id: string;
  title: string;
  status: string;
  org_id: string;
  template_id: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  finalized_at: Date | null;
  closed_reason: string | null;
  current_version_id: string | null;
  final_version_id: string | null;
}) {
  return {
    id: a.id,
    publicId: a.public_id,
    title: a.title,
    status: a.status,
    orgId: a.org_id,
    templateId: a.template_id,
    createdBy: a.created_by,
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at.toISOString(),
    expiresAt: a.expires_at?.toISOString() ?? null,
    finalizedAt: a.finalized_at?.toISOString() ?? null,
    closedReason: a.closed_reason,
    currentVersionId: a.current_version_id,
    finalVersionId: a.final_version_id,
  };
}

function serializeDetail(detail: Awaited<ReturnType<typeof getAgreement>>) {
  return {
    agreement: publicAgreement(detail.agreement),
    category: detail.meta
      ? { code: detail.meta.categoryCode, label: detail.meta.categoryLabel }
      : null,
    templateId: detail.meta?.templateId ?? null,
    templateName: detail.meta?.templateName ?? null,
    parties: detail.parties,
    sections: detail.sections,
    fields: detail.fields,
    currentVersion: detail.currentVersion
      ? {
          id: detail.currentVersion.id,
          versionNumber: detail.currentVersion.version_number,
          status: detail.currentVersion.status,
          changeSummary: detail.currentVersion.change_summary,
          documentHash: detail.currentVersion.document_hash,
          previousVersionId: detail.currentVersion.previous_version_id,
          createdAt: detail.currentVersion.created_at.toISOString(),
          finalizedAt: detail.currentVersion.finalized_at?.toISOString() ?? null,
          content: detail.currentVersion.content,
        }
      : null,
  };
}
