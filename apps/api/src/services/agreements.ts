/**
 * Agreement service (SPEC §5/§10): create, retrieve, update draft,
 * lifecycle transitions, cancel, terminate. All mutations run inside a
 * transaction and append audit events atomically.
 */
import {
  AppError,
  assertTransition,
  type AgreementStatus,
} from '@agreementhub/domain';
import type pg from 'pg';
import { exec, many, one, withTransaction, type Db, type Queryable } from '../db.js';
import type { ActorContext } from './context.js';
import { auditActor } from './context.js';
import {
  requireAccess,
  requireEdit,
  requireManage,
  type AgreementAccess,
  type AgreementRow,
} from './access.js';
import { recordAudit } from './audit.js';
import { allocatePublicId } from './publicId.js';
import {
  buildContent,
  getVersion,
  insertVersion,
  restoreWorkingCopyFromContent,
  syncVersionAfterEdit,
  type VersionRow,
} from './versions.js';
import { notifyParties } from './notifications.js';
import { avatarUrlsForUsers } from './avatars.js';
import { assertTemplateComplete, toValidatedDefinition } from './templateEngine.js';
import { emptyValues, renderSections } from '@agreementhub/domain/template';

export interface CreateAgreementInput {
  orgId?: string;
  templateId: string;
  title: string;
  brief?: string;
  expiresAt?: string;
}

export interface UpdateDraftInput {
  title?: string;
  sections?: Array<{ code: string; title: string; body: string; included: boolean }>;
  fields?: Array<{ code: string; value?: unknown; provenance: string }>;
  expiresAt?: string | null;
}

interface TemplateRow {
  id: string;
  category_id: string;
  name: string;
  template_version: number;
  status: string;
  content_schema: {
    sections?: Array<{ code: string; title: string; body?: string; order?: number }>;
  };
  signing_policy: 'PARALLEL' | 'SEQUENTIAL';
  required_approvals: number;
}

interface OrgRow {
  id: string;
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export async function createAgreement(
  db: Db,
  ctx: ActorContext,
  input: CreateAgreementInput,
): Promise<{ agreement: AgreementRow; version: VersionRow }> {
  return withTransaction(db, async (tx) => {
    // Resolve org: explicit orgId must belong to the user; default = user's first org.
    let org: OrgRow | undefined;
    if (input.orgId) {
      org = await one<OrgRow>(
        tx,
        `SELECT o.id FROM organizations o
         JOIN organization_members m ON m.org_id = o.id AND m.user_id = $1 AND m.status = 'ACTIVE'
         WHERE o.id = $2 AND o.deleted_at IS NULL`,
        [ctx.userId, input.orgId],
      );
      if (!org) throw AppError.forbidden('You are not an active member of that organization.');
    } else {
      org = await one<OrgRow>(
        tx,
        `SELECT o.id FROM organizations o
         JOIN organization_members m ON m.org_id = o.id AND m.user_id = $1 AND m.status = 'ACTIVE'
         WHERE o.deleted_at IS NULL
         ORDER BY (m.role = 'OWNER') DESC, o.created_at ASC LIMIT 1`,
        [ctx.userId],
      );
      if (!org) throw AppError.badRequest('NO_ORGANIZATION', 'Join or create an organization first.');
    }

    // Create permission: org roles OWNER/ADMIN/CREATOR (spec matrix).
    const membership = await one<{ role: string }>(
      tx,
      `SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [org.id, ctx.userId],
    );
    if (!membership || !['OWNER', 'ADMIN', 'CREATOR'].includes(membership.role)) {
      throw AppError.forbidden('Your role cannot create agreements in this organization.');
    }

    const template = await one<TemplateRow>(
      tx,
      `SELECT * FROM agreement_templates WHERE id = $1 AND status = 'PUBLISHED'`,
      [input.templateId],
    );
    if (!template) throw AppError.notFound('Template not found.');

    const publicId = await allocatePublicId(tx, process.env.AGREEMENT_ID_PREFIX ?? 'AGR-GH');

    const agreement = await one<AgreementRow>(
      tx,
      `INSERT INTO agreements
         (public_id, org_id, title, category_id, template_id, template_version,
          status, brief, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8,$9)
       RETURNING *`,
      [
        publicId,
        org.id,
        input.title,
        template.category_id,
        template.id,
        template.template_version,
        input.brief ?? null,
        ctx.userId,
        input.expiresAt ?? null,
      ],
    );
    if (!agreement) throw AppError.internal('Failed to create agreement.');

    // Compose the working copy through the template engine: definition-driven
    // sections (placeholders resolved against defaults, conditional sections
    // included/excluded) plus default field values so conditions evaluate
    // correctly from day one.
    const definition = toValidatedDefinition(template.content_schema, template.name);
    const initialValues = emptyValues(definition);
    for (const section of renderSections(definition, initialValues)) {
      const defined = definition.sections.find((s) => s.code === section.code);
      await exec(
        tx,
        `INSERT INTO agreement_sections (agreement_id, code, title, body, order_index, included)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          agreement.id,
          section.code,
          defined?.title ?? section.title,
          section.body,
          section.order,
          section.visible,
        ],
      );
    }
    for (const field of definition.fields) {
      if (field.default === undefined) continue;
      await exec(
        tx,
        `INSERT INTO agreement_fields (agreement_id, code, value, provenance, updated_by)
         VALUES ($1,$2,$3::jsonb,'USER_PROVIDED',$4)`,
        [agreement.id, field.code, JSON.stringify(field.default), ctx.userId],
      );
    }

    // Creator becomes the OWNER party.
    await exec(
      tx,
      `INSERT INTO agreement_parties
         (agreement_id, user_id, email, display_name, role, signing_order, status, added_by)
       VALUES ($1,$2,$3,$4,'OWNER',0,'VIEWED',$2)`,
      [agreement.id, ctx.userId, ctx.email, ctx.displayName],
    );

    // Version 1: initial snapshot of the working copy.
    const content = await buildContent(
      tx,
      agreement.id,
      agreement.public_id,
      agreement.title,
      template.name,
    );
    const version = await insertVersion(tx, {
      agreementId: agreement.id,
      content,
      changeSummary: 'Initial version',
      createdBy: ctx.userId,
    });

    await recordAudit(tx, {
      agreementId: agreement.id,
      orgId: org.id,
      eventType: 'AGREEMENT_CREATED',
      actor: auditActor(ctx),
      metadata: {
        publicId,
        templateId: template.id,
        templateName: template.name,
        title: input.title,
        versionNumber: version.version_number,
        documentHash: version.document_hash,
      },
      requestId: ctx.requestId,
    });

    return { agreement, version };
  });
}

/* ------------------------------------------------------------------ */
/* Retrieve                                                            */
/* ------------------------------------------------------------------ */

export interface AgreementDetail {
  agreement: AgreementRow;
  parties: unknown[];
  sections: unknown[];
  fields: unknown[];
  currentVersion: (VersionRow & { content: unknown }) | null;
  meta: {
    templateId: string;
    categoryCode: string;
    categoryLabel: string;
    templateName: string;
  } | null;
}

export async function getAgreement(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<AgreementDetail> {
  const access = await requireAccess(db, ctx.userId, ctx.email, agreementId);
  return loadDetail(db, access);
}

async function loadDetail(db: Queryable, access: AgreementAccess): Promise<AgreementDetail> {
  // Sequential on purpose: `db` may be a single transaction client, which
  // cannot run overlapping queries.
  const parties = await many<{
    id: string;
    user_id: string | null;
    email: string;
    display_name: string;
    role: string;
    signing_order: number;
    status: string;
    added_at: Date;
    signed_at: Date | null;
  }>(
    db,
    `SELECT id, user_id, email, display_name, role, signing_order, status, added_at, signed_at
     FROM agreement_parties WHERE agreement_id = $1 ORDER BY signing_order, added_at`,
    [access.agreement.id],
  );
  const avatarUrls = await avatarUrlsForUsers(
    db,
    parties.map((p) => p.user_id),
  );
  const partiesWithAvatars = parties.map((p) => ({
    ...p,
    avatarUrl: (p.user_id ? avatarUrls.get(p.user_id) : null) ?? null,
  }));
  const sections = await many(
    db,
    `SELECT id, code, title, body, order_index, included FROM agreement_sections
     WHERE agreement_id = $1 ORDER BY order_index`,
    [access.agreement.id],
  );
  const fields = await many(
    db,
    `SELECT id, code, value, provenance, updated_at FROM agreement_fields
     WHERE agreement_id = $1 ORDER BY code`,
    [access.agreement.id],
  );

  let currentVersion: (VersionRow & { content: unknown }) | null = null;
  if (access.agreement.current_version_id) {
    currentVersion =
      (await one<VersionRow & { content: unknown }>(
        db,
        `SELECT * FROM agreement_versions WHERE id = $1`,
        [access.agreement.current_version_id],
      )) ?? null;
  }

  const metaRow = await one<{
    template_id: string;
    category_code: string;
    category_label: string;
    template_name: string;
  }>(
    db,
    `SELECT t.id AS template_id, c.code AS category_code, c.label AS category_label,
            t.name AS template_name
     FROM agreements a
     JOIN template_categories c ON c.id = a.category_id
     JOIN agreement_templates t ON t.id = a.template_id
     WHERE a.id = $1`,
    [access.agreement.id],
  );
  const meta = metaRow
    ? {
        templateId: metaRow.template_id,
        categoryCode: metaRow.category_code,
        categoryLabel: metaRow.category_label,
        templateName: metaRow.template_name,
      }
    : null;

  return { agreement: access.agreement, parties: partiesWithAvatars, sections, fields, currentVersion, meta };
}

/* ------------------------------------------------------------------ */
/* Update draft                                                        */
/* ------------------------------------------------------------------ */

export async function updateDraft(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  input: UpdateDraftInput,
): Promise<AgreementDetail> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    if (access.agreement.status !== 'DRAFT' && access.agreement.status !== 'NEGOTIATION') {
      throw AppError.conflict(
        'NOT_DRAFT',
        `Draft edits are only allowed in DRAFT/NEGOTIATION status (current: ${access.agreement.status}). ` +
          'Submit changes through the review flow instead.',
      );
    }
    requireEdit(access);

    const result = await applyDraftEdits(tx, ctx, access, input);

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'AGREEMENT_UPDATED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        sectionsTouched: result.touchedSections,
        fieldsTouched: result.touchedFields,
        titleChanged: result.titleChanged,
        ...(result.versionCreated
          ? {
              newVersionNumber: result.versionCreated.version_number,
              changeSummary: result.versionCreated.change_summary,
            }
          : {}),
      },
      requestId: ctx.requestId,
    });

    const updated = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    return loadDetail(tx, updated);
  });
}

export interface DraftEditResult {
  touchedSections: string[];
  touchedFields: string[];
  titleChanged: boolean;
  /** Non-null when the edit was snapshotted into a brand-new version. */
  versionCreated: VersionRow | null;
}

/**
 * Apply working-copy edits inside an *existing* transaction. No permission or
 * status guards here, callers run them (updateDraft, proposal accept).
 *
 * Snapshot policy: while the agreement is under negotiation every meaningful
 * change (i.e. one that alters the document hash) creates a new immutable
 * version with a derived change summary ("Payment modified"); otherwise the
 * latest DRAFT version is refreshed in place. Identical content never creates
 * a version.
 */
export async function applyDraftEdits(
  tx: Queryable,
  ctx: ActorContext,
  access: AgreementAccess,
  input: UpdateDraftInput,
): Promise<DraftEditResult> {
  const agreementId = access.agreement.id;

  let titleChanged = false;
  if (input.title !== undefined && input.title !== access.agreement.title) {
    await exec(tx, `UPDATE agreements SET title = $1 WHERE id = $2`, [input.title, agreementId]);
    titleChanged = true;
  }
  if (input.expiresAt !== undefined) {
    await exec(tx, `UPDATE agreements SET expires_at = $1 WHERE id = $2`, [
      input.expiresAt,
      agreementId,
    ]);
  }

  const touched: string[] = [];
  if (input.sections) {
    for (const s of input.sections) {
      await exec(
        tx,
        `UPDATE agreement_sections SET title = $1, body = $2, included = $3
         WHERE agreement_id = $4 AND code = $5`,
        [s.title, s.body, s.included, agreementId, s.code],
      );
      touched.push(s.code);
    }
  }
  if (input.fields) {
    for (const f of input.fields) {
      await exec(
        tx,
        `INSERT INTO agreement_fields (agreement_id, code, value, provenance, updated_by)
         VALUES ($1,$2,$3::jsonb,$4,$5)
         ON CONFLICT (agreement_id, code) DO UPDATE
           SET value = EXCLUDED.value,
               provenance = EXCLUDED.provenance,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [agreementId, f.code, JSON.stringify(f.value ?? null), f.provenance, ctx.userId],
      );
    }
  }

  const { versionCreated } = await syncVersionAfterEdit(tx, ctx, access);

  return {
    touchedSections: touched,
    touchedFields: input.fields?.map((f) => f.code) ?? [],
    titleChanged,
    versionCreated,
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle transitions                                                */
/* ------------------------------------------------------------------ */

export async function transitionAgreement(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  to: AgreementStatus,
  reason?: string,
): Promise<AgreementRow> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    requireManage(access);

    const from = access.agreement.status;
    // Sealed agreements are only re-opened through startAmendment(), which
    // seeds a new version from the final document first, never here.
    if (from === 'ACTIVE' && to === 'NEGOTIATION') {
      throw AppError.conflict(
        'AMENDMENT_REQUIRED',
        'A finalized agreement is re-opened through the amendment workflow, which creates a new version from the final document first.',
      );
    }
    // Map org/party role to lifecycle actor for the domain transition table.
    const actor =
      access.membership?.role === 'REVIEWER' && !isOwner(access) ? 'REVIEWER' : 'OWNER';
    const rule = assertTransition(from, to, actor, { reason });

    // Entering the signing phase requires complete required template fields.
    if (to === 'AWAITING_SIGNATURES') {
      await assertTemplateComplete(tx, agreementId);
    }

    await exec(
      tx,
      `UPDATE agreements
       SET status = $1,
           closed_reason = CASE WHEN $1 IN ('CANCELLED','TERMINATED','REJECTED') THEN $2 ELSE closed_reason END,
           closed_at = CASE WHEN $1 IN ('CANCELLED','TERMINATED','REJECTED') THEN now() ELSE closed_at END
       WHERE id = $3`,
      [to, reason ?? null, agreementId],
    );

    const eventType =
      to === 'CANCELLED'
        ? 'AGREEMENT_CANCELLED'
        : to === 'TERMINATED'
          ? 'AGREEMENT_TERMINATED'
          : to === 'REJECTED'
            ? 'AGREEMENT_REJECTED'
            : from === 'DRAFT' && to === 'REVIEW'
              ? 'AGREEMENT_SUBMITTED'
              : 'STATUS_CHANGED';

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType,
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        from,
        to,
        trigger: rule.trigger,
        ...(reason ? { reason } : {}),
      },
      requestId: ctx.requestId,
    });

    await notifyParties(
      tx,
      agreementId,
      access.agreement.org_id,
      'STATUS_CHANGED',
      { publicId: access.agreement.public_id, from, to, title: access.agreement.title },
      ctx.userId,
    );

    const updated = await one<AgreementRow>(tx, `SELECT * FROM agreements WHERE id = $1`, [
      agreementId,
    ]);
    if (!updated) throw AppError.notFound('Agreement not found.');
    return updated;
  });
}

function isOwner(access: AgreementAccess): boolean {
  return access.membership?.role === 'OWNER' || access.party?.role === 'OWNER';
}

/* ------------------------------------------------------------------ */
/* Amendment workflow (post-finalization)                              */
/* ------------------------------------------------------------------ */

export interface AmendmentResult {
  agreement: AgreementRow;
  /** New working version seeded from the sealed final document. */
  version: VersionRow;
  finalVersionNumber: number;
}

/**
 * Start an amendment on a finalized agreement: seed a new working version
 * from the immutable final document and re-open negotiation. The final
 * version keeps its FINAL status (and hash) forever; anything agreed during
 * the amendment becomes a new version that can be approved, signed and
 * finalized again. Comments and suggestions never trigger this implicitly;
 * a manager must call it explicitly.
 */
export async function startAmendment(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<AmendmentResult> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    requireManage(access);

    if (access.agreement.status !== 'ACTIVE' || !access.agreement.final_version_id) {
      throw AppError.conflict(
        'NOT_FINALIZED',
        `Amendments can only start from a finalized agreement (current status: ${access.agreement.status}).`,
      );
    }

    const finalVersion = await getVersion(tx, access.agreement.final_version_id);
    if (!finalVersion) throw AppError.notFound('Final version not found.');

    // Same legality check as the lifecycle table; the generic status route
    // refuses this pair so the seeding below can never be skipped.
    assertTransition('ACTIVE', 'NEGOTIATION', 'OWNER');

    // High-priority correctness: restore the mutable working copy from the
    // immutable final snapshot before reopening negotiation. Without this, edits
    // and new snapshots would be based on stale working-copy rows instead of the
    // sealed terms. Parties retain their identity/history (not rewritten).
    await restoreWorkingCopyFromContent(tx, agreementId, finalVersion.content, ctx.userId);

    const created = await insertVersion(tx, {
      agreementId,
      content: finalVersion.content,
      changeSummary: `Amendment to v${finalVersion.version_number}`,
      createdBy: ctx.userId,
    });

    await exec(tx, `UPDATE agreements SET status = 'NEGOTIATION' WHERE id = $1`, [agreementId]);

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'AMENDMENT_STARTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        finalVersionId: finalVersion.id,
        finalVersionNumber: finalVersion.version_number,
        finalDocumentHash: finalVersion.document_hash,
        newVersionId: created.id,
        newVersionNumber: created.version_number,
      },
      requestId: ctx.requestId,
    });

    await notifyParties(
      tx,
      agreementId,
      access.agreement.org_id,
      'AMENDMENT_STARTED',
      {
        publicId: access.agreement.public_id,
        title: access.agreement.title,
        fromVersion: finalVersion.version_number,
      },
      ctx.userId,
    );

    const updated = await one<AgreementRow>(tx, `SELECT * FROM agreements WHERE id = $1`, [
      agreementId,
    ]);
    if (!updated) throw AppError.notFound('Agreement not found.');
    return { agreement: updated, version: created, finalVersionNumber: finalVersion.version_number };
  });
}

/* ------------------------------------------------------------------ */
/* Cancel / Terminate (named services per spec)                        */
/* ------------------------------------------------------------------ */

export async function cancelAgreement(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  reason: string,
): Promise<AgreementRow> {
  return transitionAgreement(db, ctx, agreementId, 'CANCELLED', reason);
}

export async function terminateAgreement(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  reason: string,
): Promise<AgreementRow> {
  return transitionAgreement(db, ctx, agreementId, 'TERMINATED', reason);
}

export { requireAccess };
