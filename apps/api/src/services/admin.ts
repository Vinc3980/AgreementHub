/**
 * Platform administration service (audit Phase 7).
 *
 * Privilege model: platform administrators are explicitly flagged on the user
 * row (`is_platform_admin`). Organization OWNER/ADMIN roles never imply
 * platform privileges. Every mutating action is recorded in the append-only
 * `platform_audit_events` table.
 *
 * Template history is append-only from the product's point of view: editing a
 * published template is not allowed, a new DRAFT version row is created
 * instead. Existing agreements keep their immutable finalized snapshots.
 */
import { AppError } from '@agreementhub/domain';
import { parseTemplateDefinition } from '@agreementhub/domain/template';
import type { Db, Queryable } from '../db.js';
import { exec, many, one, withTransaction } from '../db.js';
import type { ActorContext } from './context.js';

export async function requirePlatformAdmin(db: Queryable, userId: string): Promise<void> {
  const row = await one<{ is_platform_admin: boolean }>(
    db,
    `SELECT is_platform_admin FROM users WHERE id = $1`,
    [userId],
  );
  if (!row?.is_platform_admin) {
    throw AppError.forbidden('Platform administrator access required.');
  }
}

interface PlatformAuditInput {
  actor: ActorContext;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

async function recordPlatformAudit(tx: Queryable, input: PlatformAuditInput): Promise<void> {
  await exec(
    tx,
    `INSERT INTO platform_audit_events
       (actor_id, actor_label, action, target_type, target_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.actor.userId,
      input.actor.email,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export interface AdminStats {
  users: number;
  verifiedUsers: number;
  suspendedUsers: number;
  agreements: number;
  agreementsByStatus: Array<{ status: string; count: number }>;
  publishedTemplates: number;
  draftTemplates: number;
  categories: number;
  outboxPending: number;
  outboxFailed: number;
  unreadNotifications: number;
}

export async function getAdminStats(db: Queryable): Promise<AdminStats> {
  const counts = await one<{
    users: number;
    verified_users: number;
    suspended_users: number;
    agreements: number;
    published_templates: number;
    draft_templates: number;
    categories: number;
    outbox_pending: number;
    outbox_failed: number;
    unread_notifications: number;
  }>(
    db,
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users,
       (SELECT COUNT(*)::int FROM users WHERE email_verified_at IS NOT NULL) AS verified_users,
       (SELECT COUNT(*)::int FROM users WHERE status = 'SUSPENDED') AS suspended_users,
       (SELECT COUNT(*)::int FROM agreements WHERE deleted_at IS NULL) AS agreements,
       (SELECT COUNT(*)::int FROM agreement_templates WHERE status = 'PUBLISHED') AS published_templates,
       (SELECT COUNT(*)::int FROM agreement_templates WHERE status = 'DRAFT') AS draft_templates,
       (SELECT COUNT(*)::int FROM template_categories) AS categories,
       (SELECT COUNT(*)::int FROM email_outbox WHERE status IN ('PENDING', 'SENDING')) AS outbox_pending,
       (SELECT COUNT(*)::int FROM email_outbox WHERE status = 'FAILED') AS outbox_failed,
       (SELECT COUNT(*)::int FROM notifications WHERE read_at IS NULL) AS unread_notifications`,
  );
  const byStatus = await many<{ status: string; count: number }>(
    db,
    `SELECT status, COUNT(*)::int AS count
       FROM agreements WHERE deleted_at IS NULL
      GROUP BY status ORDER BY count DESC`,
  );

  return {
    users: counts?.users ?? 0,
    verifiedUsers: counts?.verified_users ?? 0,
    suspendedUsers: counts?.suspended_users ?? 0,
    agreements: counts?.agreements ?? 0,
    agreementsByStatus: byStatus,
    publishedTemplates: counts?.published_templates ?? 0,
    draftTemplates: counts?.draft_templates ?? 0,
    categories: counts?.categories ?? 0,
    outboxPending: counts?.outbox_pending ?? 0,
    outboxFailed: counts?.outbox_failed ?? 0,
    unreadNotifications: counts?.unread_notifications ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export interface AdminUserRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  email_verified_at: Date | null;
  is_platform_admin: boolean;
  created_at: Date;
  organizations: number;
}

export async function listAdminUsers(
  db: Queryable,
  options: { q?: string; limit: number; offset: number },
): Promise<AdminUserRow[]> {
  return many<AdminUserRow>(
    db,
    `SELECT u.id, u.email, u.display_name, u.status, u.email_verified_at,
            u.is_platform_admin, u.created_at,
            (SELECT COUNT(*)::int FROM organization_members m
              WHERE m.user_id = u.id AND m.status = 'ACTIVE') AS organizations
       FROM users u
      WHERE u.deleted_at IS NULL
        AND ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%'
             OR u.display_name ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC
      LIMIT $2 OFFSET $3`,
    [options.q?.trim() || null, options.limit, options.offset],
  );
}

export async function updateAdminUser(
  db: Db,
  actor: ActorContext,
  targetId: string,
  patch: { status?: 'ACTIVE' | 'SUSPENDED'; isPlatformAdmin?: boolean },
): Promise<AdminUserRow> {
  return withTransaction(db, async (tx) => {
    const target = await one<AdminUserRow & { is_platform_admin: boolean }>(
      tx,
      `SELECT id, email, display_name, status, email_verified_at, is_platform_admin,
              created_at, 0 AS organizations
         FROM users WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
      [targetId],
    );
    if (!target) throw AppError.notFound('User not found.');

    if (patch.status && target.id === actor.userId && patch.status !== 'ACTIVE') {
      throw AppError.conflict('SELF_SUSPEND', 'You cannot suspend your own account.');
    }

    if (patch.isPlatformAdmin === false && target.is_platform_admin) {
      const admins = await one<{ count: number }>(
        tx,
        `SELECT COUNT(*)::int AS count FROM users
          WHERE is_platform_admin = true AND deleted_at IS NULL`,
      );
      if ((admins?.count ?? 0) <= 1) {
        throw AppError.conflict(
          'LAST_ADMIN',
          'At least one platform administrator must remain.',
        );
      }
    }

    const status = patch.status ?? target.status;
    const isAdmin = patch.isPlatformAdmin ?? target.is_platform_admin;
    await exec(
      tx,
      `UPDATE users
          SET status = $2, is_platform_admin = $3, updated_at = now()
        WHERE id = $1`,
      [targetId, status, isAdmin],
    );

    // Suspension revokes every live session immediately.
    if (patch.status === 'SUSPENDED') {
      await exec(
        tx,
        `UPDATE auth_sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [targetId],
      );
    }

    await recordPlatformAudit(tx, {
      actor,
      action: 'USER_UPDATED',
      targetType: 'USER',
      targetId,
      metadata: {
        email: target.email,
        statusChanged: patch.status ?? null,
        isPlatformAdminChanged: patch.isPlatformAdmin ?? null,
      },
    });

    const updated = await one<AdminUserRow>(
      tx,
      `SELECT id, email, display_name, status, email_verified_at, is_platform_admin,
              created_at,
              (SELECT COUNT(*)::int FROM organization_members m
                WHERE m.user_id = users.id AND m.status = 'ACTIVE') AS organizations
         FROM users WHERE id = $1`,
      [targetId],
    );
    if (!updated) throw AppError.internal('Failed to reload the user.');
    return updated;
  });
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export async function listAdminCategories(db: Queryable) {
  return many(
    db,
    `SELECT c.id, c.code, c.label, c.sort_order, c.is_enabled, c.created_at,
            (SELECT COUNT(*)::int FROM agreement_templates t
              WHERE t.category_id = c.id) AS template_count
       FROM template_categories c
      ORDER BY c.sort_order, c.label`,
  );
}

export async function createAdminCategory(
  db: Db,
  actor: ActorContext,
  input: { code: string; label: string; sortOrder: number },
) {
  return withTransaction(db, async (tx) => {
    const existing = await one<{ id: string }>(
      tx,
      `SELECT id FROM template_categories WHERE code = $1`,
      [input.code],
    );
    if (existing) throw AppError.conflict('CATEGORY_EXISTS', 'That category code already exists.');

    const row = await one<{ id: string; code: string; label: string; sort_order: number; is_enabled: boolean; created_at: Date }>(
      tx,
      `INSERT INTO template_categories (code, label, sort_order)
       VALUES ($1,$2,$3) RETURNING id, code, label, sort_order, is_enabled, created_at`,
      [input.code, input.label, input.sortOrder],
    );
    if (!row) throw AppError.internal('Failed to create the category.');
    await recordPlatformAudit(tx, {
      actor,
      action: 'CATEGORY_CREATED',
      targetType: 'CATEGORY',
      targetId: row.id,
      metadata: { code: input.code, label: input.label },
    });
    return row;
  });
}

export async function updateAdminCategory(
  db: Db,
  actor: ActorContext,
  id: string,
  patch: { label?: string; sortOrder?: number; isEnabled?: boolean },
) {
  return withTransaction(db, async (tx) => {
    const row = await one<{ id: string; code: string; label: string; sort_order: number; is_enabled: boolean; created_at: Date }>(
      tx,
      `UPDATE template_categories
          SET label = COALESCE($2, label),
              sort_order = COALESCE($3, sort_order),
              is_enabled = COALESCE($4, is_enabled),
              updated_at = now()
        WHERE id = $1
        RETURNING id, code, label, sort_order, is_enabled, created_at`,
      [id, patch.label ?? null, patch.sortOrder ?? null, patch.isEnabled ?? null],
    );
    if (!row) throw AppError.notFound('Category not found.');
    await recordPlatformAudit(tx, {
      actor,
      action: 'CATEGORY_UPDATED',
      targetType: 'CATEGORY',
      targetId: id,
      metadata: patch as Record<string, unknown>,
    });
    return row;
  });
}

/* ------------------------------------------------------------------ */
/* Templates + version history                                         */
/* ------------------------------------------------------------------ */

const TEMPLATE_SELECT = `
  SELECT t.id, t.name, t.description, t.template_version, t.signing_policy,
         t.required_approvals, t.status, t.created_at, t.updated_at,
         c.id AS category_id, c.code AS category_code, c.label AS category_label
    FROM agreement_templates t
    JOIN template_categories c ON c.id = t.category_id`;

export async function listAdminTemplates(db: Queryable) {
  return many(
    db,
    `${TEMPLATE_SELECT}
      ORDER BY c.sort_order, t.name, t.template_version DESC`,
  );
}

function assertValidDefinition(raw: unknown): void {
  if (!parseTemplateDefinition(raw)) {
    throw AppError.badRequest(
      'INVALID_TEMPLATE',
      'The template definition is not a valid document schema.',
    );
  }
}

export async function createAdminTemplate(
  db: Db,
  actor: ActorContext,
  input: {
    categoryId: string;
    name: string;
    description: string;
    definition: unknown;
    signingPolicy: 'PARALLEL' | 'SEQUENTIAL';
    requiredApprovals: number;
  },
) {
  assertValidDefinition(input.definition);
  return withTransaction(db, async (tx) => {
    const category = await one<{ id: string }>(
      tx,
      `SELECT id FROM template_categories WHERE id = $1`,
      [input.categoryId],
    );
    if (!category) throw AppError.badRequest('CATEGORY_NOT_FOUND', 'Category not found.');

    const duplicate = await one<{ id: string }>(
      tx,
      `SELECT id FROM agreement_templates
        WHERE category_id = $1 AND lower(name) = lower($2)`,
      [input.categoryId, input.name],
    );
    if (duplicate) {
      throw AppError.conflict(
        'TEMPLATE_EXISTS',
        'A template with this name already exists in the category. Create a new version instead.',
      );
    }

    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO agreement_templates
         (category_id, name, description, template_version, content_schema,
          signing_policy, required_approvals, status, created_by)
       VALUES ($1,$2,$3,1,$4,$5,$6,'DRAFT',$7)
       RETURNING id`,
      [
        input.categoryId,
        input.name,
        input.description,
        JSON.stringify(input.definition),
        input.signingPolicy,
        input.requiredApprovals,
        actor.userId,
      ],
    );
    if (!row) throw AppError.internal('Failed to create the template.');
    await recordPlatformAudit(tx, {
      actor,
      action: 'TEMPLATE_CREATED',
      targetType: 'TEMPLATE',
      targetId: row.id,
      metadata: { name: input.name, categoryId: input.categoryId },
    });
    return row;
  });
}

export async function updateAdminTemplate(
  db: Db,
  actor: ActorContext,
  id: string,
  patch: { description?: string; signingPolicy?: 'PARALLEL' | 'SEQUENTIAL'; requiredApprovals?: number },
) {
  return withTransaction(db, async (tx) => {
    const template = await one<{ id: string; status: string; name: string }>(
      tx,
      `SELECT id, status, name FROM agreement_templates WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!template) throw AppError.notFound('Template not found.');
    // Published versions are immutable: create a new version instead.
    if (template.status !== 'DRAFT') {
      throw AppError.conflict(
        'TEMPLATE_IMMUTABLE',
        'Published or retired template versions cannot be edited. Create a new version.',
      );
    }

    await exec(
      tx,
      `UPDATE agreement_templates
          SET description = COALESCE($2, description),
              signing_policy = COALESCE($3, signing_policy),
              required_approvals = COALESCE($4, required_approvals),
              updated_at = now()
        WHERE id = $1`,
      [id, patch.description ?? null, patch.signingPolicy ?? null, patch.requiredApprovals ?? null],
    );
    await recordPlatformAudit(tx, {
      actor,
      action: 'TEMPLATE_UPDATED',
      targetType: 'TEMPLATE',
      targetId: id,
      metadata: patch as Record<string, unknown>,
    });
    return { ok: true };
  });
}

export async function publishAdminTemplate(db: Db, actor: ActorContext, id: string) {
  return withTransaction(db, async (tx) => {
    const template = await one<{ id: string; status: string; category_id: string; name: string }>(
      tx,
      `SELECT id, status, category_id, name FROM agreement_templates WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!template) throw AppError.notFound('Template not found.');
    if (template.status !== 'DRAFT') {
      throw AppError.conflict('NOT_DRAFT', 'Only draft templates can be published.');
    }

    // Only one published version per (category, name).
    await exec(
      tx,
      `UPDATE agreement_templates
          SET status = 'RETIRED', updated_at = now()
        WHERE category_id = $1 AND lower(name) = lower($2)
          AND status = 'PUBLISHED' AND id <> $3`,
      [template.category_id, template.name, id],
    );
    await exec(
      tx,
      `UPDATE agreement_templates SET status = 'PUBLISHED', updated_at = now() WHERE id = $1`,
      [id],
    );
    await recordPlatformAudit(tx, {
      actor,
      action: 'TEMPLATE_PUBLISHED',
      targetType: 'TEMPLATE',
      targetId: id,
      metadata: { name: template.name, categoryId: template.category_id },
    });
    return { ok: true, status: 'PUBLISHED' };
  });
}

export async function retireAdminTemplate(db: Db, actor: ActorContext, id: string) {
  return withTransaction(db, async (tx) => {
    const template = await one<{ id: string; status: string; name: string }>(
      tx,
      `SELECT id, status, name FROM agreement_templates WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!template) throw AppError.notFound('Template not found.');
    if (template.status !== 'PUBLISHED') {
      throw AppError.conflict('NOT_PUBLISHED', 'Only published templates can be retired.');
    }
    await exec(
      tx,
      `UPDATE agreement_templates SET status = 'RETIRED', updated_at = now() WHERE id = $1`,
      [id],
    );
    await recordPlatformAudit(tx, {
      actor,
      action: 'TEMPLATE_RETIRED',
      targetType: 'TEMPLATE',
      targetId: id,
      metadata: { name: template.name },
    });
    return { ok: true, status: 'RETIRED' };
  });
}

export async function createAdminTemplateVersion(
  db: Db,
  actor: ActorContext,
  id: string,
  input: { definition: unknown; description?: string },
) {
  assertValidDefinition(input.definition);
  return withTransaction(db, async (tx) => {
    const template = await one<{
      id: string;
      category_id: string;
      name: string;
      description: string;
      signing_policy: string;
      required_approvals: number;
    }>(
      tx,
      `SELECT id, category_id, name, description, signing_policy, required_approvals
         FROM agreement_templates WHERE id = $1`,
      [id],
    );
    if (!template) throw AppError.notFound('Template not found.');

    const next = await one<{ version: number }>(
      tx,
      `SELECT COALESCE(MAX(template_version), 0) + 1 AS version
         FROM agreement_templates
        WHERE category_id = $1 AND lower(name) = lower($2)`,
      [template.category_id, template.name],
    );

    const row = await one<{ id: string; template_version: number }>(
      tx,
      `INSERT INTO agreement_templates
         (category_id, name, description, template_version, content_schema,
          signing_policy, required_approvals, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8)
       RETURNING id, template_version`,
      [
        template.category_id,
        template.name,
        input.description ?? template.description,
        next?.version ?? 2,
        JSON.stringify(input.definition),
        template.signing_policy,
        template.required_approvals,
        actor.userId,
      ],
    );
    if (!row) throw AppError.internal('Failed to create the template version.');
    await recordPlatformAudit(tx, {
      actor,
      action: 'TEMPLATE_VERSION_CREATED',
      targetType: 'TEMPLATE',
      targetId: row.id,
      metadata: { baseTemplateId: id, name: template.name, version: row.template_version },
    });
    return row;
  });
}

export async function listAdminTemplateVersions(db: Queryable, id: string) {
  const base = await one<{ category_id: string; name: string }>(
    db,
    `SELECT category_id, name FROM agreement_templates WHERE id = $1`,
    [id],
  );
  if (!base) throw AppError.notFound('Template not found.');

  return many(
    db,
    `SELECT id, name, description, template_version, signing_policy,
            required_approvals, status, created_at, updated_at,
            content_schema
       FROM agreement_templates
      WHERE category_id = $1 AND lower(name) = lower($2)
      ORDER BY template_version DESC`,
    [base.category_id, base.name],
  );
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

export async function listAdminActivity(db: Queryable, limit: number) {
  const adminActions = await many(
    db,
    `SELECT id, actor_label, action, target_type, target_id, metadata, created_at
       FROM platform_audit_events
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  // Global agreement/system activity, safe projection only (no metadata,
  // which can contain internal details).
  const systemActivity = await many(
    db,
    `SELECT e.event_type, e.actor_type, e.actor_label, e.occurred_at, a.public_id
       FROM audit_events e
       LEFT JOIN agreements a ON a.id = e.agreement_id
      ORDER BY e.occurred_at DESC
      LIMIT $1`,
    [limit],
  );
  return { adminActions, systemActivity };
}
