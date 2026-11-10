/**
 * Change proposals, the negotiation "suggest changes" workflow.
 *
 * A proposal is a *suggestion only*: creating or rejecting one never touches
 * the document. Applying one requires an explicit accept from a user with
 * edit rights, and that accept runs through the normal draft-update path,
 * so during negotiation it creates a new version exactly like any other
 * meaningful modification, and on a finalized agreement it is refused.
 */
import { AppError, canonicalJson } from '@agreementhub/domain';
import { many, one, withTransaction, type Db, type Queryable } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import {
  requireAccess,
  requireCommenter,
  requireEdit,
  type AgreementAccess,
} from './access.js';
import { recordAudit } from './audit.js';
import { notifyParties } from './notifications.js';
import { applyDraftEdits, type UpdateDraftInput } from './agreements.js';
import type { VersionRow } from './versions.js';
import { parseTemplateDefinition } from '@agreementhub/domain/template';

export type ProposalKind = 'TITLE' | 'SECTION' | 'FIELD';
export type ProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export type ProposalDecision = 'ACCEPTED' | 'REJECTED';

export interface ProposalRow {
  id: string;
  agreement_id: string;
  version_id: string | null;
  kind: ProposalKind;
  target_code: string;
  current_value: unknown;
  proposed_value: unknown;
  note: string;
  status: ProposalStatus;
  proposed_by: string;
  proposed_by_label: string;
  decided_by: string | null;
  /** Email of the decider, joined in list queries (null on freshly returned rows). */
  decided_by_label?: string | null;
  decided_at: Date | null;
  decision_note: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProposalInput {
  agreementId: string;
  versionId?: string;
  kind: ProposalKind;
  targetCode: string;
  proposedValue: unknown;
  note?: string;
}

/** Statuses in which suggestions may be raised at all. */
const OPEN_FOR_SUGGESTIONS = ['DRAFT', 'REVIEW', 'NEGOTIATION'];

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

export async function listProposals(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<ProposalRow[]> {
  const access = await requireAccess(db, ctx.userId, ctx.email, agreementId);
  return many<ProposalRow>(
    db,
    `SELECT cp.*, u.email AS decided_by_label
       FROM change_proposals cp
       LEFT JOIN users u ON u.id = cp.decided_by
      WHERE cp.agreement_id = $1
      ORDER BY cp.created_at ASC, cp.id ASC`,
    [access.agreement.id],
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export async function createProposal(
  db: Db,
  ctx: ActorContext,
  input: CreateProposalInput,
): Promise<ProposalRow> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, input.agreementId);
    requireCommenter(access);

    if (!OPEN_FOR_SUGGESTIONS.includes(access.agreement.status)) {
      throw AppError.conflict(
        'NEGOTIATION_CLOSED',
        `Change suggestions are closed while the agreement is ${access.agreement.status}.`,
      );
    }

    const target = await resolveTarget(tx, access, input.kind, input.targetCode, input.proposedValue);

    const open = await one<{ id: string }>(
      tx,
      `SELECT id FROM change_proposals
       WHERE agreement_id = $1 AND kind = $2 AND target_code = $3 AND status = 'PENDING'`,
      [access.agreement.id, input.kind, target.code],
    );
    if (open) {
      throw AppError.conflict(
        'PROPOSAL_EXISTS',
        'There is already an open suggestion for this target, decide it first.',
      );
    }

    const versionId = input.versionId ?? access.agreement.current_version_id;
    if (versionId) {
      const belongs = await one<{ id: string }>(
        tx,
        `SELECT id FROM agreement_versions WHERE id = $1 AND agreement_id = $2`,
        [versionId, access.agreement.id],
      );
      if (!belongs) {
        throw AppError.badRequest('INVALID_VERSION', 'Version does not belong to this agreement.');
      }
    }

    const row = await one<ProposalRow>(
      tx,
      `INSERT INTO change_proposals
         (agreement_id, version_id, kind, target_code, current_value, proposed_value,
          note, proposed_by, proposed_by_label)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
       RETURNING *`,
      [
        access.agreement.id,
        versionId ?? null,
        input.kind,
        target.code,
        JSON.stringify(target.current ?? null),
        JSON.stringify(target.proposed),
        input.note?.trim() ?? '',
        ctx.userId,
        ctx.email,
      ],
    );
    if (!row) throw AppError.internal('Failed to create the suggestion.');

    await recordAudit(tx, {
      agreementId: access.agreement.id,
      orgId: access.agreement.org_id,
      eventType: 'CHANGE_SUGGESTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        proposalId: row.id,
        kind: input.kind,
        targetCode: target.code,
        noteLength: row.note.length,
      },
      requestId: ctx.requestId,
    });

    await notifyParties(
      tx,
      access.agreement.id,
      access.agreement.org_id,
      'CHANGE_SUGGESTED',
      {
        publicId: access.agreement.public_id,
        title: access.agreement.title,
        kind: input.kind,
        targetCode: target.code,
      },
      ctx.userId,
    );

    return row;
  });
}

interface ResolvedTarget {
  code: string;
  current: unknown;
  proposed: unknown;
}

/** Validate the suggestion target against the live working copy. */
async function resolveTarget(
  tx: Queryable,
  access: AgreementAccess,
  kind: ProposalKind,
  targetCode: string,
  proposedValue: unknown,
): Promise<ResolvedTarget> {
  const agreementId = access.agreement.id;

  if (kind === 'TITLE') {
    if (targetCode !== 'title') {
      throw AppError.badRequest('INVALID_TARGET', 'A title suggestion must use targetCode "title".');
    }
    const title = requireText(proposedValue, 'title', 300);
    if (title === access.agreement.title) throw noChange('title');
    return { code: 'title', current: access.agreement.title, proposed: title };
  }

  if (kind === 'SECTION') {
    const row = await one<{ code: string; title: string; body: string; included: boolean }>(
      tx,
      `SELECT code, title, body, included FROM agreement_sections
       WHERE agreement_id = $1 AND code = $2`,
      [agreementId, targetCode],
    );
    if (!row) {
      throw AppError.badRequest('UNKNOWN_SECTION', `No section with code "${targetCode}".`);
    }
    if (!proposedValue || typeof proposedValue !== 'object' || Array.isArray(proposedValue)) {
      throw AppError.badRequest(
        'INVALID_PROPOSAL_VALUE',
        'A section suggestion must be an object with (some of) title, body, included.',
      );
    }
    const raw = proposedValue as Record<string, unknown>;
    const title = raw.title === undefined ? row.title : requireText(raw.title, 'title', 300);
    const body = raw.body === undefined ? row.body : requireText(raw.body, 'body', 100000);
    const included =
      raw.included === undefined
        ? row.included
        : typeof raw.included === 'boolean'
          ? raw.included
          : (() => {
              throw AppError.badRequest('INVALID_PROPOSAL_VALUE', '"included" must be a boolean.');
            })();
    const proposed = { title, body, included };
    if (canonicalJson(proposed) === canonicalJson({ title: row.title, body: row.body, included: row.included })) {
      throw noChange(`section "${row.code}"`);
    }
    return {
      code: row.code,
      current: { title: row.title, body: row.body, included: row.included },
      proposed,
    };
  }

  // FIELD, target must exist either as a stored value or in the template.
  const row = await one<{ code: string; value: unknown }>(
    tx,
    `SELECT code, value FROM agreement_fields WHERE agreement_id = $1 AND code = $2`,
    [agreementId, targetCode],
  );
  const template = await one<{ content_schema: unknown }>(
    tx,
    `SELECT content_schema FROM agreement_templates WHERE id = $1`,
    [access.agreement.template_id],
  );
  const definition = template ? parseTemplateDefinition(template.content_schema) : null;
  const knownInTemplate = definition?.fields.some((f) => f.code === targetCode) ?? false;
  if (!row && !knownInTemplate) {
    throw AppError.badRequest('UNKNOWN_FIELD', `No field with code "${targetCode}".`);
  }
  if (proposedValue === undefined) {
    throw AppError.badRequest('INVALID_PROPOSAL_VALUE', 'A field suggestion needs a proposedValue.');
  }
  const current = row?.value ?? null;
  if (canonicalJson(current) === canonicalJson(proposedValue)) throw noChange(`field "${targetCode}"`);
  return { code: targetCode, current, proposed: proposedValue };
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw AppError.badRequest('INVALID_PROPOSAL_VALUE', `"${label}" must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw AppError.badRequest('INVALID_PROPOSAL_VALUE', `"${label}" must be at most ${max} characters.`);
  }
  return trimmed;
}

function noChange(target: string): AppError {
  return AppError.badRequest('NO_CHANGE', `The suggested ${target} is identical to the current one.`);
}

/* ------------------------------------------------------------------ */
/* Decide (accept / reject)                                            */
/* ------------------------------------------------------------------ */

export async function decideProposal(
  db: Db,
  ctx: ActorContext,
  proposalId: string,
  decision: ProposalDecision,
  note?: string,
): Promise<{ proposal: ProposalRow; versionCreated: VersionRow | null }> {
  return withTransaction(db, async (tx) => {
    const proposal = await one<ProposalRow>(
      tx,
      `SELECT * FROM change_proposals WHERE id = $1`,
      [proposalId],
    );
    if (!proposal) throw AppError.notFound('Suggestion not found.');
    const access = await requireAccess(tx, ctx.userId, ctx.email, proposal.agreement_id);
    requireCommenter(access);

    if (proposal.status !== 'PENDING') {
      throw AppError.conflict(
        'PROPOSAL_DECIDED',
        `This suggestion was already ${proposal.status.toLowerCase()}.`,
      );
    }

    if (decision === 'REJECTED') {
      const updated = await markDecided(tx, proposal, 'REJECTED', ctx.userId, note);
      await recordDecision(tx, access, proposal, 'CHANGE_REJECTED', ctx, note);
      return { proposal: updated, versionCreated: null };
    }

    // ACCEPT, an explicit user action by someone who may edit the working
    // copy; this is the only way a suggestion ever changes the document.
    if (access.agreement.status !== 'DRAFT' && access.agreement.status !== 'NEGOTIATION') {
      throw AppError.conflict(
        'NOT_DRAFT',
        `Suggestions can only be applied while the agreement is DRAFT or NEGOTIATION (current: ${access.agreement.status}).`,
      );
    }
    requireEdit(access);

    const result = await applyDraftEdits(tx, ctx, access, payloadFor(proposal));
    const updated = await markDecided(tx, proposal, 'ACCEPTED', ctx.userId, note);

    await recordAudit(tx, {
      agreementId: proposal.agreement_id,
      orgId: access.agreement.org_id,
      eventType: 'CHANGE_ACCEPTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        proposalId: proposal.id,
        kind: proposal.kind,
        targetCode: proposal.target_code,
        ...(result.versionCreated
          ? {
              newVersionNumber: result.versionCreated.version_number,
              changeSummary: result.versionCreated.change_summary,
            }
          : {}),
      },
      requestId: ctx.requestId,
    });
    await notifyParties(
      tx,
      proposal.agreement_id,
      access.agreement.org_id,
      'CHANGE_DECIDED',
      {
        publicId: access.agreement.public_id,
        title: access.agreement.title,
        targetCode: proposal.target_code,
        decision: 'ACCEPTED',
      },
      ctx.userId,
    );

    return { proposal: updated, versionCreated: result.versionCreated };
  });
}

async function markDecided(
  tx: Queryable,
  proposal: ProposalRow,
  status: ProposalStatus,
  userId: string,
  note?: string,
): Promise<ProposalRow> {
  const updated = await one<ProposalRow>(
    tx,
    `UPDATE change_proposals
     SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3
     WHERE id = $4 AND status = 'PENDING'
     RETURNING *`,
    [status, userId, note?.trim() ?? '', proposal.id],
  );
  if (!updated) {
    throw AppError.conflict('PROPOSAL_DECIDED', 'This suggestion was already decided.');
  }
  return updated;
}

async function recordDecision(
  tx: Queryable,
  access: AgreementAccess,
  proposal: ProposalRow,
  eventType: 'CHANGE_REJECTED',
  ctx: ActorContext,
  note?: string,
): Promise<void> {
  await recordAudit(tx, {
    agreementId: proposal.agreement_id,
    orgId: access.agreement.org_id,
    eventType,
    actor: auditActor(ctx),
    metadata: {
      publicId: access.agreement.public_id,
      proposalId: proposal.id,
      kind: proposal.kind,
      targetCode: proposal.target_code,
      noteLength: note?.trim().length ?? 0,
    },
    requestId: ctx.requestId,
  });
  await notifyParties(
    tx,
    proposal.agreement_id,
    access.agreement.org_id,
    'CHANGE_DECIDED',
    {
      publicId: access.agreement.public_id,
      title: access.agreement.title,
      targetCode: proposal.target_code,
      decision: 'REJECTED',
    },
    ctx.userId,
  );
}

/** Turn an accepted proposal into the draft-update payload that applies it. */
function payloadFor(proposal: ProposalRow): UpdateDraftInput {
  if (proposal.kind === 'TITLE') {
    return { title: String(proposal.proposed_value) };
  }
  if (proposal.kind === 'SECTION') {
    const value = proposal.proposed_value as { title: string; body: string; included: boolean };
    return {
      sections: [
        {
          code: proposal.target_code,
          title: value.title,
          body: value.body,
          included: value.included,
        },
      ],
    };
  }
  return {
    fields: [
      {
        code: proposal.target_code,
        value: proposal.proposed_value,
        provenance: 'USER_PROVIDED',
      },
    ],
  };
}
