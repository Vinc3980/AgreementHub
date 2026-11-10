/**
 * Post-signature obligation tracking (lifecycle support).
 *
 * Obligations are agreement-scoped records with responsible parties and due
 * dates. Time-based states (UPCOMING/DUE_SOON/OVERDUE) may advance via the
 * scheduler, but COMPLETED/CANCELLED are explicit user actions and are NEVER
 * inferred from the due date passing.
 */
import { AppError } from '@agreementhub/domain';
import { many, one, withTransaction, type Db, type Queryable } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import { requireAccess, requireManage, listParties } from './access.js';
import { notify } from './notifications.js';
import { getNotificationPreferences } from './accounts.js';

export type ObligationStatus = 'UPCOMING' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED' | 'CANCELLED';

export interface ObligationRow {
  id: string;
  agreement_id: string;
  version_id: string | null;
  responsible_party_id: string | null;
  responsible_label: string | null;
  title: string;
  description: string | null;
  due_at: Date;
  status: ObligationStatus;
  notes: string | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_by: string;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  responsible_party_name?: string | null;
  responsible_party_email?: string | null;
  responsible_user_id?: string | null;
}

const SELECT_OBLIGATION = `
  SELECT o.*, p.display_name AS responsible_party_name, p.email AS responsible_party_email, p.user_id AS responsible_user_id
    FROM agreement_obligations o
    LEFT JOIN agreement_parties p ON p.id = o.responsible_party_id
`;

function daysUntil(dueAt: Date, now = Date.now()): number {
  const ms = dueAt.getTime() - now;
  return Math.floor(ms / 86_400_000);
}

export function derivedActiveStatus(dueAt: Date, now = Date.now()): Extract<ObligationStatus, 'UPCOMING' | 'DUE_SOON' | 'OVERDUE'> {
  const days = daysUntil(dueAt, now);
  if (days < 0) return 'OVERDUE';
  if (days <= 3) return 'DUE_SOON';
  return 'UPCOMING';
}

export function effectiveStatus(row: Pick<ObligationRow, 'status' | 'due_at'>, now = Date.now()): ObligationStatus {
  if (row.status === 'COMPLETED' || row.status === 'CANCELLED') return row.status;
  return derivedActiveStatus(row.due_at, now);
}

export interface ObligationDto {
  id: string;
  agreementId: string;
  versionId: string | null;
  responsiblePartyId: string | null;
  responsibleLabel: string | null;
  responsibleName: string | null;
  responsibleEmail: string | null;
  title: string;
  description: string | null;
  dueAt: string;
  status: ObligationStatus;
  notes: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDto(row: ObligationRow): ObligationDto {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    versionId: row.version_id,
    responsiblePartyId: row.responsible_party_id,
    responsibleLabel: row.responsible_label,
    responsibleName: row.responsible_party_name ?? row.responsible_label ?? null,
    responsibleEmail: row.responsible_party_email ?? null,
    title: row.title,
    description: row.description,
    dueAt: row.due_at.toISOString(),
    status: effectiveStatus(row),
    notes: row.notes,
    completedAt: row.completed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function assertManageAgreement(db: Queryable, ctx: ActorContext, agreementId: string) {
  const access = await requireAccess(db, ctx.userId, ctx.email, agreementId);
  // Post-signature usefulness: allow managers; for MVP keep to manage rights.
  requireManage(access);
  return access;
}

export async function listObligations(db: Queryable, ctx: ActorContext, agreementId: string): Promise<ObligationDto[]> {
  await requireAccess(db, ctx.userId, ctx.email, agreementId);
  const rows = await many<ObligationRow>(
    db,
    `${SELECT_OBLIGATION} WHERE o.agreement_id = $1 ORDER BY o.due_at ASC, o.created_at ASC`,
    [agreementId],
  );
  return rows.map(toDto);
}

const VISIBILITY = `(
  EXISTS (SELECT 1 FROM organization_members m
          WHERE m.org_id = a.org_id AND m.user_id = $1 AND m.status = 'ACTIVE'
            AND (m.role <> 'MEMBER'
                 OR EXISTS (SELECT 1 FROM agreement_parties p
                            WHERE p.agreement_id = a.id AND p.user_id = $1)))
  OR EXISTS (SELECT 1 FROM agreement_parties p
             WHERE p.agreement_id = a.id AND p.user_id = $1)
)`;

export interface ObligationOverviewFilters {
  agreementId?: string;
  status?: ObligationStatus;
  assigned?: 'me' | 'others' | 'all';
  dueFrom?: string;
  dueTo?: string;
  limit?: number;
}

export interface ObligationOverviewItem extends ObligationDto {
  agreementPublicId: string;
  agreementTitle: string;
  agreementStatus: string;
  assignedToMe: boolean;
  needsReview: boolean;
  governingVersionNumber: number | null;
  currentVersionNumber: number | null;
}

export async function listObligationsOverview(db: Queryable, ctx: ActorContext, filters: ObligationOverviewFilters = {}) {
  const params: unknown[] = [ctx.userId, ctx.email];
  const where: string[] = ['a.deleted_at IS NULL', VISIBILITY];
  if (filters.agreementId) { params.push(filters.agreementId); where.push(`o.agreement_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); where.push(`o.status = $${params.length}`); }
  if (filters.assigned === 'me') {
    params.push(ctx.userId);
    where.push(`(p.user_id = $${params.length} OR lower(COALESCE(p.email,'')) = lower($2))`);
  } else if (filters.assigned === 'others') {
    params.push(ctx.userId);
    where.push(`(p.user_id IS DISTINCT FROM $${params.length} AND (p.user_id IS NOT NULL OR COALESCE(o.responsible_label,'') <> ''))`);
  }
  if (filters.dueFrom) { params.push(filters.dueFrom); where.push(`o.due_at >= $${params.length}::timestamptz`); }
  if (filters.dueTo) { params.push(filters.dueTo); where.push(`o.due_at <= $${params.length}::timestamptz`); }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
  params.push(limit);

  const rows = await many<ObligationRow & {
    agreement_public_id: string; agreement_title: string; agreement_status: string;
    governing_version_number: number | null; current_version_number: number | null;
    assigned_to_me: boolean;
  }>(
    db,
    `SELECT o.*, p.display_name AS responsible_party_name, p.email AS responsible_party_email, p.user_id AS responsible_user_id,
            a.public_id AS agreement_public_id, a.title AS agreement_title, a.status AS agreement_status,
            gv.version_number AS governing_version_number, cv.version_number AS current_version_number,
            (p.user_id = $1 OR lower(COALESCE(p.email,'')) = lower($2)) AS assigned_to_me
       FROM agreement_obligations o
       LEFT JOIN agreement_parties p ON p.id = o.responsible_party_id
       JOIN agreements a ON a.id = o.agreement_id
       LEFT JOIN agreement_versions gv ON gv.id = o.version_id
       LEFT JOIN agreement_versions cv ON cv.id = COALESCE(a.final_version_id, a.current_version_id)
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN o.status = 'OVERDUE' THEN 0 WHEN o.status = 'DUE_SOON' THEN 1 WHEN o.status = 'UPCOMING' THEN 2 WHEN o.status = 'COMPLETED' THEN 3 ELSE 4 END,
        o.due_at ASC
      LIMIT $${params.length}`,
    params,
  );

  const obligations: ObligationOverviewItem[] = rows.map((row) => {
    const dto = toDto(row);
    const gov = row.governing_version_number;
    const cur = row.current_version_number;
    const needsReview = !!(gov && cur && gov !== cur) && row.status !== 'COMPLETED' && row.status !== 'CANCELLED';
    return {
      ...dto,
      agreementPublicId: row.agreement_public_id,
      agreementTitle: row.agreement_title,
      agreementStatus: row.agreement_status,
      assignedToMe: !!row.assigned_to_me,
      needsReview,
      governingVersionNumber: gov ?? null,
      currentVersionNumber: cur ?? null,
    };
  });

  const summary = {
    total: obligations.length,
    upcoming: obligations.filter((o) => o.status === 'UPCOMING' || o.status === 'DUE_SOON').length,
    overdue: obligations.filter((o) => o.status === 'OVERDUE').length,
    recentlyCompleted: obligations.filter((o) => o.status === 'COMPLETED').length,
    assignedToMe: obligations.filter((o) => o.assignedToMe).length,
    assignedToOthers: obligations.filter((o) => !o.assignedToMe && (o.responsiblePartyId || o.responsibleLabel)).length,
    needsReview: obligations.filter((o) => o.needsReview).length,
  };
  return { obligations, summary };
}

export interface CreateObligationInput {
  agreementId: string;
  versionId?: string | null;
  responsiblePartyId?: string | null;
  responsibleLabel?: string | null;
  title: string;
  description?: string | null;
  dueAt: string;
  notes?: string | null;
}

export async function createObligation(db: Db, ctx: ActorContext, input: CreateObligationInput): Promise<ObligationDto> {
  return withTransaction(db, async (tx) => {
    const access = await assertManageAgreement(tx, ctx, input.agreementId);
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw AppError.badRequest('INVALID_DUE_DATE', 'Provide a valid due date.');
    const title = input.title.trim();
    if (title.length < 2) throw AppError.badRequest('INVALID_TITLE', 'Provide an obligation title.');

    let responsiblePartyId: string | null = input.responsiblePartyId ?? null;
    if (responsiblePartyId) {
      const parties = await listParties(tx, input.agreementId);
      if (!parties.some((p) => p.id === responsiblePartyId)) {
        throw AppError.badRequest('INVALID_PARTY', 'Responsible party must belong to this agreement.');
      }
    }
    const versionId = input.versionId ?? access.agreement.final_version_id ?? access.agreement.current_version_id ?? null;
    const status = derivedActiveStatus(dueAt);
    const row = await one<ObligationRow>(
      tx,
      `INSERT INTO agreement_obligations
         (agreement_id, version_id, responsible_party_id, responsible_label, title, description, due_at, status, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING *`,
      [
        input.agreementId,
        versionId,
        responsiblePartyId,
        input.responsibleLabel?.trim() || null,
        title,
        input.description?.trim() || null,
        dueAt,
        status,
        input.notes?.trim() || null,
        ctx.userId,
      ],
    );
    if (!row) throw AppError.internal('Failed to create obligation.');
    const full = await one<ObligationRow>(tx, `${SELECT_OBLIGATION} WHERE o.id = $1`, [row.id]);
    return toDto(full ?? row);
  });
}

export interface UpdateObligationInput {
  title?: string;
  description?: string | null;
  dueAt?: string;
  responsiblePartyId?: string | null;
  responsibleLabel?: string | null;
  notes?: string | null;
  versionId?: string | null;
}

async function loadObligationForManage(db: Queryable, ctx: ActorContext, obligationId: string) {
  const row = await one<ObligationRow>(db, `${SELECT_OBLIGATION} WHERE o.id = $1`, [obligationId]);
  if (!row) throw AppError.notFound('Obligation not found.');
  await assertManageAgreement(db, ctx, row.agreement_id);
  return row;
}

export async function updateObligation(db: Db, ctx: ActorContext, obligationId: string, input: UpdateObligationInput): Promise<ObligationDto> {
  return withTransaction(db, async (tx) => {
    const existing = await loadObligationForManage(tx, ctx, obligationId);
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      // Allow notes? keep simple: prevent edits to terminal records except via future reopen.
      throw AppError.conflict('OBLIGATION_NOT_EDITABLE', 'Completed or cancelled obligations cannot be edited.');
    }
    const dueAt = input.dueAt ? new Date(input.dueAt) : existing.due_at;
    if (Number.isNaN(dueAt.getTime())) throw AppError.badRequest('INVALID_DUE_DATE', 'Provide a valid due date.');
    let responsiblePartyId = input.responsiblePartyId !== undefined ? input.responsiblePartyId : existing.responsible_party_id;
    if (responsiblePartyId) {
      const parties = await listParties(tx, existing.agreement_id);
      if (!parties.some((p) => p.id === responsiblePartyId)) throw AppError.badRequest('INVALID_PARTY', 'Responsible party must belong to this agreement.');
    }
    const status = derivedActiveStatus(dueAt);
    const row = await one<ObligationRow>(
      tx,
      `UPDATE agreement_obligations
          SET title = $2, description = $3, due_at = $4, status = $5,
              responsible_party_id = $6, responsible_label = $7, notes = $8, version_id = $9,
              updated_by = $10, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        obligationId,
        input.title !== undefined ? input.title.trim() : existing.title,
        input.description !== undefined ? (input.description?.trim() || null) : existing.description,
        dueAt,
        status,
        responsiblePartyId ?? null,
        input.responsibleLabel !== undefined ? (input.responsibleLabel?.trim() || null) : existing.responsible_label,
        input.notes !== undefined ? (input.notes?.trim() || null) : existing.notes,
        input.versionId !== undefined ? input.versionId : existing.version_id,
        ctx.userId,
      ],
    );
    if (!row) throw AppError.notFound('Obligation not found.');
    const full = await one<ObligationRow>(tx, `${SELECT_OBLIGATION} WHERE o.id = $1`, [row.id]);
    return toDto(full ?? row);
  });
}

export async function completeObligation(db: Db, ctx: ActorContext, obligationId: string, notes?: string | null): Promise<ObligationDto> {
  return withTransaction(db, async (tx) => {
    await loadObligationForManage(tx, ctx, obligationId);
    const row = await one<ObligationRow>(
      tx,
      `UPDATE agreement_obligations
          SET status = 'COMPLETED', completed_at = now(), cancelled_at = NULL,
              notes = COALESCE($2, notes), updated_by = $3, updated_at = now()
        WHERE id = $1 AND status <> 'CANCELLED'
        RETURNING *`,
      [obligationId, notes?.trim() || null, ctx.userId],
    );
    if (!row) throw AppError.conflict('OBLIGATION_CANNOT_COMPLETE', 'Obligation cannot be completed.');
    const full = await one<ObligationRow>(tx, `${SELECT_OBLIGATION} WHERE o.id = $1`, [row.id]);
    return toDto(full ?? row);
  });
}

export async function cancelObligation(db: Db, ctx: ActorContext, obligationId: string, notes?: string | null): Promise<ObligationDto> {
  return withTransaction(db, async (tx) => {
    await loadObligationForManage(tx, ctx, obligationId);
    const row = await one<ObligationRow>(
      tx,
      `UPDATE agreement_obligations
          SET status = 'CANCELLED', cancelled_at = now(), completed_at = NULL,
              notes = COALESCE($2, notes), updated_by = $3, updated_at = now()
        WHERE id = $1 AND status <> 'COMPLETED'
        RETURNING *`,
      [obligationId, notes?.trim() || null, ctx.userId],
    );
    if (!row) throw AppError.conflict('OBLIGATION_CANNOT_CANCEL', 'Obligation cannot be cancelled.');
    const full = await one<ObligationRow>(tx, `${SELECT_OBLIGATION} WHERE o.id = $1`, [row.id]);
    return toDto(full ?? row);
  });
}

export async function reopenObligation(db: Db, ctx: ActorContext, obligationId: string): Promise<ObligationDto> {
  return withTransaction(db, async (tx) => {
    const existing = await loadObligationForManage(tx, ctx, obligationId);
    const status = derivedActiveStatus(existing.due_at);
    const row = await one<ObligationRow>(
      tx,
      `UPDATE agreement_obligations
          SET status = $2, completed_at = NULL, cancelled_at = NULL, updated_by = $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [obligationId, status, ctx.userId],
    );
    if (!row) throw AppError.notFound('Obligation not found.');
    const full = await one<ObligationRow>(tx, `${SELECT_OBLIGATION} WHERE o.id = $1`, [row.id]);
    return toDto(full ?? row);
  });
}

interface ObligationReminderRow extends ObligationRow {
  agreement_public_id: string;
  agreement_title: string;
  agreement_org_id: string;
  agreement_deleted_at: Date | null;
  agreement_status: string;
}

function obligationRecipients(row: ObligationReminderRow): Array<{ userId: string; dedupeUser: string }> {
  const ids = new Set<string>();
  if (row.responsible_user_id) ids.add(row.responsible_user_id);
  // Fallback: notify creator? better to notify responsible party; if none, skip noisy broadcast in MVP.
  // (Could be extended to agreement managers via a preference.)
  return [...ids].map((userId) => ({ userId, dedupeUser: userId }));
}

/** Background: advance time-based statuses and send idempotent reminders. Never completes obligations. */
export async function runObligationReminders(db: Db): Promise<{ updated: number; reminders: number }> {
  let updated = 0;
  let reminders = 0;
  // 1) Advance active statuses (not terminal)
  const active = await many<ObligationRow>(
    db,
    `SELECT * FROM agreement_obligations WHERE status IN ('UPCOMING','DUE_SOON','OVERDUE')`,
    [],
  );
  for (const row of active) {
    const next = derivedActiveStatus(row.due_at);
    if (next !== row.status) {
      await db.query(`UPDATE agreement_obligations SET status = $2, updated_at = now() WHERE id = $1 AND status IN ('UPCOMING','DUE_SOON','OVERDUE')`, [row.id, next]);
      updated += 1;
    }
  }

  // 2) Reminders (idempotent by dedupe key)
  const rows = await many<ObligationReminderRow>(
    db,
    `SELECT o.*, p.display_name AS responsible_party_name, p.email AS responsible_party_email, p.user_id AS responsible_user_id,
            a.public_id AS agreement_public_id, a.title AS agreement_title, a.org_id AS agreement_org_id,
            a.deleted_at AS agreement_deleted_at, a.status AS agreement_status
       FROM agreement_obligations o
       LEFT JOIN agreement_parties p ON p.id = o.responsible_party_id
       JOIN agreements a ON a.id = o.agreement_id
      WHERE o.status IN ('UPCOMING','DUE_SOON','OVERDUE')
        AND a.deleted_at IS NULL`,
    [],
  );

  for (const row of rows) {
    const daysLeft = daysUntil(row.due_at);
    const recipients = obligationRecipients(row);
    for (const rec of recipients) {
      const prefs = await getNotificationPreferences(db, rec.userId).catch(() => null);
      const intervals = prefs?.obligationReminderDays ?? [7, 3, 1, 0, -1];
      if (!intervals.includes(daysLeft)) continue;
      // Avoid excessive post-due reminders: only configured negative day (e.g. -1) fires once.
      const isOverdue = daysLeft < 0;
      const type = isOverdue ? 'OBLIGATION_OVERDUE' : 'OBLIGATION_REMINDER';
      const dueKey = row.due_at.toISOString().slice(0, 10);
      const dedupeKey = `obligation:${row.id}:${daysLeft}:${rec.dedupeUser}:${dueKey}`;
      const responsible = row.responsible_party_name ?? row.responsible_label ?? row.responsible_party_email ?? null;
      await withTransaction(db, async (tx) => {
        const sent = await notify(tx, {
          userId: rec.userId,
          type,
          orgId: row.agreement_org_id,
          agreementId: row.agreement_id,
          payload: {
            publicId: row.agreement_public_id,
            title: row.agreement_title,
            obligationId: row.id,
            obligationTitle: row.title,
            dueAt: row.due_at.toISOString(),
            daysLeft,
            daysOverdue: Math.max(0, -daysLeft),
            responsible,
          },
          dedupeKey,
        });
        if (sent) reminders += 1;
      });
    }
  }
  return { updated, reminders };
}
