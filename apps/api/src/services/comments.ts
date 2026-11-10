/**
 * Comment service (SPEC §FR-7): threaded comments attached to a version
 * (and optionally a section), always audited.
 */
import { AppError } from '@agreementhub/domain';
import type { Db } from '../db.js';
import { many, one, withTransaction } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import { canManage, requireAccess, requireCommenter } from './access.js';
import { recordAudit } from './audit.js';
import { notifyParties } from './notifications.js';

export interface CommentRow {
  id: string;
  agreement_id: string;
  version_id: string | null;
  section_code: string | null;
  parent_id: string | null;
  author_type: string;
  author_id: string | null;
  author_label: string;
  body: string;
  status: 'OPEN' | 'RESOLVED';
  created_at: Date;
  resolved_at: Date | null;
}

export interface AddCommentInput {
  agreementId: string;
  versionId?: string;
  sectionCode?: string;
  parentId?: string;
  body: string;
}

export async function addComment(
  db: Db,
  ctx: ActorContext,
  input: AddCommentInput,
): Promise<CommentRow> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, input.agreementId);
    requireCommenter(access);

    const status = access.agreement.status;
    if (['CANCELLED', 'TERMINATED', 'EXPIRED'].includes(status)) {
      throw AppError.conflict(
        'AGREEMENT_CLOSED',
        `Comments are closed: agreement is ${status}.`,
      );
    }

    // Comments attach to the current version by default (negotiation context).
    const versionId = input.versionId ?? access.agreement.current_version_id;
    if (versionId) {
      const belongs = await one<{ id: string }>(
        tx,
        `SELECT id FROM agreement_versions WHERE id = $1 AND agreement_id = $2`,
        [versionId, input.agreementId],
      );
      if (!belongs) throw AppError.badRequest('INVALID_VERSION', 'Version does not belong to this agreement.');
    }

    if (input.parentId) {
      const parent = await one<{ id: string }>(
        tx,
        `SELECT id FROM comments WHERE id = $1 AND agreement_id = $2`,
        [input.parentId, input.agreementId],
      );
      if (!parent) throw AppError.badRequest('INVALID_PARENT', 'Parent comment not found.');
    }

    const comment = await one<CommentRow>(
      tx,
      `INSERT INTO comments
         (agreement_id, version_id, section_code, parent_id, author_type, author_id, author_label, body)
       VALUES ($1,$2,$3,$4,'USER',$5,$6,$7)
       RETURNING *`,
      [
        input.agreementId,
        versionId,
        input.sectionCode ?? null,
        input.parentId ?? null,
        ctx.userId,
        ctx.email,
        input.body,
      ],
    );
    if (!comment) throw AppError.internal('Failed to add comment.');

    await recordAudit(tx, {
      agreementId: input.agreementId,
      orgId: access.agreement.org_id,
      eventType: 'PARTY_COMMENTED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        commentId: comment.id,
        sectionCode: input.sectionCode ?? null,
        versionId,
        length: input.body.length,
      },
      requestId: ctx.requestId,
    });

    await notifyParties(
      tx,
      input.agreementId,
      access.agreement.org_id,
      'COMMENT_ADDED',
      {
        publicId: access.agreement.public_id,
        title: access.agreement.title,
        sectionCode: input.sectionCode ?? null,
        excerpt: input.body.slice(0, 140),
      },
      ctx.userId,
    );

    return comment;
  });
}

export async function listComments(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
): Promise<CommentRow[]> {
  const access = await requireAccess(db, ctx.userId, ctx.email, agreementId);
  return many<CommentRow>(
    db,
    `SELECT * FROM comments WHERE agreement_id = $1 ORDER BY created_at ASC`,
    [access.agreement.id],
  );
}

/**
 * Open/close a comment thread (status is recorded per the negotiation spec:
 * author, timestamp, section, content, status). The author or an agreement
 * manager may change it; closed agreements refuse further changes.
 */
export async function setCommentStatus(
  db: Db,
  ctx: ActorContext,
  commentId: string,
  status: 'OPEN' | 'RESOLVED',
): Promise<CommentRow> {
  return withTransaction(db, async (tx) => {
    const existing = await one<CommentRow>(tx, `SELECT * FROM comments WHERE id = $1`, [commentId]);
    if (!existing) throw AppError.notFound('Comment not found.');
    // Visibility check first, invisible resources stay indistinguishable.
    const access = await requireAccess(tx, ctx.userId, ctx.email, existing.agreement_id);

    const isAuthor = existing.author_id === ctx.userId;
    if (!isAuthor && !canManage(access)) {
      throw AppError.forbidden('Only the comment author or an agreement manager can change its status.');
    }

    const agreementStatus = access.agreement.status;
    if (['CANCELLED', 'TERMINATED', 'EXPIRED'].includes(agreementStatus)) {
      throw AppError.conflict(
        'AGREEMENT_CLOSED',
        `Comments are closed: agreement is ${agreementStatus}.`,
      );
    }
    if (existing.status === status) return existing;

    const updated = await one<CommentRow>(
      tx,
      `UPDATE comments
       SET status = $1,
           resolved_at = CASE WHEN $1 = 'RESOLVED' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [status, commentId],
    );
    if (!updated) throw AppError.internal('Failed to update comment status.');

    await recordAudit(tx, {
      agreementId: existing.agreement_id,
      orgId: access.agreement.org_id,
      eventType: 'COMMENT_STATUS_CHANGED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        commentId: existing.id,
        sectionCode: existing.section_code,
        from: existing.status,
        to: status,
      },
      requestId: ctx.requestId,
    });

    await notifyParties(
      tx,
      existing.agreement_id,
      access.agreement.org_id,
      'COMMENT_STATUS_CHANGED',
      {
        publicId: access.agreement.public_id,
        title: access.agreement.title,
        sectionCode: existing.section_code,
        status,
      },
      ctx.userId,
    );

    return updated;
  });
}
