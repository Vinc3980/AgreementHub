/**
 * /admin routes (audit Phase 7). Server-side platform-administrator checks on
 * every endpoint, frontend route guards are never the control.
 */
import type { FastifyInstance } from 'fastify';
import {
  adminCategoryCreateRequestSchema,
  adminCategoryUpdateRequestSchema,
  adminTemplateCreateRequestSchema,
  adminTemplateUpdateRequestSchema,
  adminTemplateVersionRequestSchema,
  adminUpdateUserRequestSchema,
} from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import {
  createAdminCategory,
  createAdminTemplate,
  createAdminTemplateVersion,
  getAdminStats,
  listAdminActivity,
  listAdminCategories,
  listAdminTemplates,
  listAdminTemplateVersions,
  listAdminUsers,
  publishAdminTemplate,
  requirePlatformAdmin,
  retireAdminTemplate,
  updateAdminCategory,
  updateAdminTemplate,
  updateAdminUser,
} from '../services/admin.js';
import type { ActorContext } from '../services/context.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  // Authentication first, then the server-side administrator check.
  const adminOnly = async (request: { actor?: ActorContext }): Promise<void> => {
    const ctx = actorOf(request);
    await requirePlatformAdmin(db, ctx.userId);
  };
  const guard = { preHandler: [authenticate, adminOnly] };

  /* ------------------------------ overview ----------------------------- */
  app.get('/admin/stats', guard, async () => ({ stats: await getAdminStats(db) }));

  /* -------------------------------- users ------------------------------ */
  app.get('/admin/users', guard, async (request) => {
    const query = request.query as { q?: string; limit?: string; offset?: string };
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50));
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);
    const users = await listAdminUsers(db, { q: query.q, limit, offset });
    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        status: u.status,
        emailVerifiedAt: iso(u.email_verified_at),
        isPlatformAdmin: u.is_platform_admin,
        organizations: u.organizations,
        createdAt: u.created_at.toISOString(),
      })),
      limit,
      offset,
    };
  });

  app.patch('/admin/users/:id', guard, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = adminUpdateUserRequestSchema.parse(request.body ?? {});
    const user = await updateAdminUser(db, ctx, id, input);
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        status: user.status,
        emailVerifiedAt: iso(user.email_verified_at),
        isPlatformAdmin: user.is_platform_admin,
        organizations: user.organizations,
        createdAt: user.created_at.toISOString(),
      },
    };
  });

  /* ----------------------------- categories ---------------------------- */
  app.get('/admin/categories', guard, async () => {
    const rows = await listAdminCategories(db);
    return {
      categories: rows.map((c) => ({
        id: c.id,
        code: c.code,
        label: c.label,
        sortOrder: c.sort_order,
        isEnabled: c.is_enabled,
        templateCount: c.template_count,
        createdAt: c.created_at.toISOString(),
      })),
    };
  });

  app.post('/admin/categories', guard, async (request, reply) => {
    const ctx = actorOf(request);
    const input = adminCategoryCreateRequestSchema.parse(request.body ?? {});
    const row = await createAdminCategory(db, ctx, input);
    return reply.status(201).send({
      category: {
        id: row.id,
        code: row.code,
        label: row.label,
        sortOrder: row.sort_order,
        isEnabled: row.is_enabled,
        createdAt: row.created_at.toISOString(),
      },
    });
  });

  app.patch('/admin/categories/:id', guard, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = adminCategoryUpdateRequestSchema.parse(request.body ?? {});
    const row = await updateAdminCategory(db, ctx, id, input);
    return {
      category: {
        id: row.id,
        code: row.code,
        label: row.label,
        sortOrder: row.sort_order,
        isEnabled: row.is_enabled,
        createdAt: row.created_at.toISOString(),
      },
    };
  });

  /* ------------------------------ templates ---------------------------- */
  app.get('/admin/templates', guard, async () => {
    const rows = await listAdminTemplates(db);
    return {
      templates: rows.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        version: t.template_version,
        signingPolicy: t.signing_policy,
        requiredApprovals: t.required_approvals,
        status: t.status,
        categoryId: t.category_id,
        categoryCode: t.category_code,
        categoryLabel: t.category_label,
        createdAt: t.created_at.toISOString(),
        updatedAt: t.updated_at.toISOString(),
      })),
    };
  });

  app.post('/admin/templates', guard, async (request, reply) => {
    const ctx = actorOf(request);
    const input = adminTemplateCreateRequestSchema.parse(request.body ?? {});
    const row = await createAdminTemplate(db, ctx, input);
    return reply.status(201).send({ template: { id: row.id } });
  });

  app.patch('/admin/templates/:id', guard, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = adminTemplateUpdateRequestSchema.parse(request.body ?? {});
    return updateAdminTemplate(db, ctx, id, input);
  });

  app.post('/admin/templates/:id/publish', guard, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    return publishAdminTemplate(db, ctx, id);
  });

  app.post('/admin/templates/:id/retire', guard, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    return retireAdminTemplate(db, ctx, id);
  });

  app.post('/admin/templates/:id/versions', guard, async (request, reply) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const input = adminTemplateVersionRequestSchema.parse(request.body ?? {});
    const row = await createAdminTemplateVersion(db, ctx, id, input);
    return reply.status(201).send({
      version: { id: row.id, versionNumber: row.template_version },
    });
  });

  app.get('/admin/templates/:id/versions', guard, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await listAdminTemplateVersions(db, id);
    return {
      versions: rows.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        version: v.template_version,
        signingPolicy: v.signing_policy,
        requiredApprovals: v.required_approvals,
        status: v.status,
        contentSchema: v.content_schema,
        createdAt: v.created_at.toISOString(),
        updatedAt: v.updated_at.toISOString(),
      })),
    };
  });

  /* ------------------------------ activity ----------------------------- */
  app.get('/admin/activity', guard, async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
    const activity = await listAdminActivity(db, limit);
    return {
      adminActions: activity.adminActions.map((a) => ({
        id: a.id,
        actorLabel: a.actor_label,
        action: a.action,
        targetType: a.target_type,
        targetId: a.target_id,
        metadata: a.metadata,
        createdAt: a.created_at.toISOString(),
      })),
      systemActivity: activity.systemActivity.map((e) => ({
        eventType: e.event_type,
        actorType: e.actor_type,
        actorLabel: e.actor_label,
        publicId: e.public_id,
        occurredAt: e.occurred_at.toISOString(),
      })),
    };
  });
}
