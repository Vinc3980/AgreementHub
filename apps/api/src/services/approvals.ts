/**
 * Approval service (electronic acceptance, SPEC §FR-7/FR-10.1):
 * requestApproval asks parties to accept a version; recordApproval stores
 * the decision. When the approval policy is satisfied the version becomes
 * APPROVED and the agreement moves to AWAITING_SIGNATURES.
 */
import { AppError, assertTransition } from '@agreementhub/domain';
import type { Db } from '../db.js';
import { exec, one, withTransaction } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import { requireAccess, requireApprover, requireManage } from './access.js';
import { recordAudit } from './audit.js';
import { notify } from './notifications.js';
import { assertTemplateComplete } from './templateEngine.js';

export interface ApprovalRow {
  id: string;
  agreement_id: string;
  version_id: string;
  party_id: string;
  decision: 'APPROVED' | 'REJECTED';
  comment: string | null;
  decided_at: Date;
}

export interface RequestApprovalInput {
  agreementId: string;
  versionId?: string;
  partyIds?: string[];
  note?: string;
}

export async function requestApproval(
  db: Db,
  ctx: ActorContext,
  input: RequestApprovalInput,
): Promise<{ versionId: string; notified: number }> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, input.agreementId);
    requireManage(access);

    const status = access.agreement.status;
    if (!['DRAFT', 'REVIEW', 'NEGOTIATION'].includes(status)) {
      throw AppError.conflict(
        'APPROVAL_NOT_ALLOWED',
        `Approvals cannot be requested while the agreement is ${status}.`,
      );
    }

    // Required template information must be complete before approvals start
    // (blocks premature finalization with missing required fields).
    await assertTemplateComplete(tx, input.agreementId);

    const versionId = input.versionId ?? access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version to approve.');

    const version = await one<{ id: string; status: string }>(
      tx,
      `SELECT id, status FROM agreement_versions WHERE id = $1 AND agreement_id = $2`,
      [versionId, input.agreementId],
    );
    if (!version) throw AppError.notFound('Version not found.');
    if (['FINAL', 'SUPERSEDED', 'REJECTED'].includes(version.status)) {
      throw AppError.conflict(
        'VERSION_LOCKED',
        `Version status ${version.status} cannot be sent for approval.`,
      );
    }

    await exec(tx, `UPDATE agreement_versions SET status = 'PENDING_APPROVAL' WHERE id = $1`, [
      versionId,
    ]);

    // Notify approver parties (default: all non-OBSERVER parties).
    const approvers = await one<{ rows: Array<{ user_id: string | null }> }>(
      tx,
      `SELECT COALESCE(
             json_agg(json_build_object('user_id', user_id)),
             '[]'::json
           ) AS rows
       FROM agreement_parties
       WHERE agreement_id = $1
         AND role IN ('OWNER','CONTRIBUTOR','REVIEWER','SIGNER')
         AND user_id IS NOT NULL
         AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [input.agreementId, input.partyIds ?? null],
    );
    let notified = 0;
    for (const row of approvers?.rows ?? []) {
      if (!row.user_id) continue;
      await notify(tx, {
        userId: row.user_id,
        type: 'APPROVAL_REQUESTED',
        orgId: access.agreement.org_id,
        agreementId: input.agreementId,
        payload: {
          publicId: access.agreement.public_id,
          title: access.agreement.title,
          note: input.note ?? null,
        },
        dedupeKey: `approval:${versionId}:${row.user_id}`,
      });
      notified += 1;
    }

    await recordAudit(tx, {
      agreementId: input.agreementId,
      orgId: access.agreement.org_id,
      eventType: 'APPROVAL_REQUESTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        versionId,
        partyIds: input.partyIds ?? 'ALL_APPROVERS',
        notified,
      },
      requestId: ctx.requestId,
    });

    return { versionId, notified };
  });
}

export interface RecordApprovalInput {
  agreementId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment?: string;
}

export async function recordApproval(
  db: Db,
  ctx: ActorContext,
  input: RecordApprovalInput,
): Promise<{ approval: ApprovalRow; policySatisfied: boolean; newStatus: string }> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, input.agreementId);
    const party = requireApprover(access);

    const versionId = access.agreement.current_version_id;
    if (!versionId) throw AppError.badRequest('NO_VERSION', 'Agreement has no version.');

    const version = await one<{ id: string; status: string }>(
      tx,
      `SELECT id, status FROM agreement_versions WHERE id = $1`,
      [versionId],
    );
    if (!version) throw AppError.notFound('Version not found.');
    if (version.status === 'FINAL') {
      throw AppError.conflict('VERSION_FINAL', 'This version is already finalized.');
    }

    const approval = await one<ApprovalRow>(
      tx,
      `INSERT INTO approvals (agreement_id, version_id, party_id, decision, comment, actor_ip, actor_ua)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (version_id, party_id)
       DO UPDATE SET decision = EXCLUDED.decision, comment = EXCLUDED.comment, decided_at = now()
       RETURNING *`,
      [
        input.agreementId,
        versionId,
        party.id,
        input.decision,
        input.comment ?? null,
        ctx.ip ?? null,
        ctx.userAgent ?? null,
      ],
    );
    if (!approval) throw AppError.internal('Failed to record approval.');

    await exec(
      tx,
      `UPDATE agreement_parties SET status = $1 WHERE id = $2`,
      [input.decision === 'APPROVED' ? 'APPROVED' : 'DECLINED', party.id],
    );

    await recordAudit(tx, {
      agreementId: input.agreementId,
      orgId: access.agreement.org_id,
      eventType: input.decision === 'APPROVED' ? 'PARTY_APPROVED' : 'PARTY_REJECTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        versionId,
        partyId: party.id,
        decision: input.decision,
        ...(input.comment ? { commentLength: input.comment.length } : {}),
      },
      requestId: ctx.requestId,
    });

    if (input.decision === 'REJECTED') {
      await exec(tx, `UPDATE agreement_versions SET status = 'REJECTED' WHERE id = $1`, [versionId]);
      return { approval, policySatisfied: false, newStatus: 'REJECTED' };
    }

    // Policy: template.required_approvals distinct APPROVED parties.
    const template = await one<{ required_approvals: number }>(
      tx,
      `SELECT t.required_approvals FROM agreement_templates t
       JOIN agreements a ON a.template_id = t.id WHERE a.id = $1`,
      [input.agreementId],
    );
    const counts = await one<{ approved: number }>(
      tx,
      `SELECT COUNT(DISTINCT party_id)::int AS approved
       FROM approvals WHERE version_id = $1 AND decision = 'APPROVED'`,
      [versionId],
    );
    const required = template?.required_approvals ?? 1;
    const satisfied = (counts?.approved ?? 0) >= required;

    let newStatus = version.status;
    if (satisfied && version.status !== 'APPROVED') {
      await exec(tx, `UPDATE agreement_versions SET status = 'APPROVED' WHERE id = $1`, [versionId]);

      // Auto-advance the lifecycle when all approvals are in (spec §10.2).
      const current = access.agreement.status;
      if (current === 'REVIEW' || current === 'NEGOTIATION') {
        assertTransition(current, 'AWAITING_SIGNATURES', 'SYSTEM');
        await exec(tx, `UPDATE agreements SET status = 'AWAITING_SIGNATURES' WHERE id = $1`, [
          input.agreementId,
        ]);
        await recordAudit(tx, {
          agreementId: input.agreementId,
          orgId: access.agreement.org_id,
          eventType: 'STATUS_CHANGED',
          actor: { type: 'SYSTEM', label: 'approval-policy' },
          metadata: {
            publicId: access.agreement.public_id,
            from: current,
            to: 'AWAITING_SIGNATURES',
            trigger: 'all approvals recorded',
          },
          requestId: ctx.requestId,
        });
      }
      newStatus = 'APPROVED';
    }

    return { approval, policySatisfied: satisfied, newStatus };
  });
}
