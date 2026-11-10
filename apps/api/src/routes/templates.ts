/**
 * /templates routes: browse categories and templates (published only),
 * plus the template-engine endpoints (preview/generate composed documents).
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agreementhub/domain';
import {
  templateGenerateRequestSchema,
  templatePreviewRequestSchema,
} from '@agreementhub/contracts';
import { many } from '../db.js';
import { authenticate } from '../plugins/auth.js';
import { requireAccess } from '../services/access.js';
import type { ActorContext } from '../services/context.js';
import { generateTemplate, previewTemplate } from '../services/templateEngine.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerTemplateRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.get('/templates/categories', async () => {
    const rows = await many(
      db,
      `SELECT c.code, c.label, c.sort_order,
              (SELECT COUNT(DISTINCT (t.category_id, t.name))::int FROM agreement_templates t
               WHERE t.category_id = c.id AND t.status = 'PUBLISHED') AS template_count
       FROM template_categories c
       WHERE c.is_enabled = true
       ORDER BY c.sort_order, c.label`,
    );
    return { categories: rows };
  });

  app.get('/templates', async (request) => {
    const query = request.query as { category?: string };
    // Latest published version per template, so new agreements use the newest
    // definition (v2: GHS defaults, payment methods) while v1 rows remain for
    // existing agreements.
    const rows = await many(
      db,
      `SELECT id, name, description, template_version, signing_policy,
              required_approvals, category_code, category_label
         FROM (
           SELECT DISTINCT ON (t.category_id, t.name)
                  t.id, t.name, t.description, t.template_version, t.signing_policy,
                  t.required_approvals, c.code AS category_code, c.label AS category_label,
                  c.sort_order
             FROM agreement_templates t
             JOIN template_categories c ON c.id = t.category_id
            WHERE t.status = 'PUBLISHED' AND c.is_enabled = true
              AND ($1::text IS NULL OR c.code = $1)
            ORDER BY t.category_id, t.name, t.template_version DESC
         ) latest
        ORDER BY sort_order, name`,
      [query.category ?? null],
    );
    return { templates: rows };
  });

  app.get('/templates/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = await many(
      db,
      `SELECT t.id, t.name, t.description, t.template_version, t.signing_policy,
              t.required_approvals, t.content_schema,
              c.code AS category_code, c.label AS category_label
       FROM agreement_templates t
       JOIN template_categories c ON c.id = t.category_id
       WHERE t.id::text = $1 AND t.status = 'PUBLISHED'`,
      [id],
    );
    if (row.length === 0) {
      throw AppError.notFound('Template not found.');
    }
    return { template: row[0] };
  });

  /* --------------------- template engine: preview ---------------------- */
  app.post(
    '/agreements/:id/template/preview',
    { preHandler: authenticate },
    async (request) => {
      const ctx = actorOf(request);
      const { id } = request.params as { id: string };
      // Visibility: any party (or org member) who can read the agreement may
      // preview its composed document. Content never leaks to non-members.
      await requireAccess(db, ctx.userId, ctx.email, id);
      const input = templatePreviewRequestSchema.parse(request.body ?? {});
      const result = await previewTemplate(db, id, input.values);
      const { definition: _definition, ...rest } = result;
      return rest;
    },
  );

  /* --------------------- template engine: generate --------------------- */
  app.post(
    '/agreements/:id/template/generate',
    { preHandler: authenticate },
    async (request) => {
      const ctx = actorOf(request);
      const { id } = request.params as { id: string };
      const input = templateGenerateRequestSchema.parse(request.body ?? {});
      const result = await generateTemplate(db, ctx, id, input.values);
      const { definition: _definition, ...rest } = result;
      return rest;
    },
  );
}
