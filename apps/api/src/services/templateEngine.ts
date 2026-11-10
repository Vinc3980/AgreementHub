/**
 * Template engine service, bridges stored template definitions and stored
 * agreement field values to the pure evaluator in @agreementhub/domain/template.
 *
 * Responsibilities:
 *  - load + validate a template definition (zod shape, then semantic problems);
 *  - evaluate an agreement (visible fields/sections, issues, missing required);
 *  - preview a composed document WITHOUT writing (optional unsaved overlay);
 *  - generate: persist field values + composed section bodies into the
 *    working copy (DRAFT/NEGOTIATION only, same guards as updateDraft);
 *  - assertTemplateComplete: 400 gate used before approval requests,
 *    signature requests, transitions into signing, and finalization.
 *
 * The engine outputs STRUCTURED PLAIN DATA (sections + values). HTML/PDF
 * conversion happens downstream in renderers, never here.
 */
import { AppError } from '@agreementhub/domain';
import {
  emptyValues,
  findDefinitionProblems,
  findMissingRequired,
  parseTemplateDefinition,
  renderSections,
  validateValues,
  visibleFields,
  type MissingRequiredField,
  type RenderedTemplateSection,
  type TemplateDefinition,
  type TemplateFieldDef,
  type TemplateFieldIssue,
  type TemplateValues,
} from '@agreementhub/domain/template';
import { templateDefinitionSchema, type TemplateValues as ZodTemplateValues } from '@agreementhub/contracts';
import type { Db, Queryable } from '../db.js';
import { exec, many, one, withTransaction } from '../db.js';
import { auditActor, type ActorContext } from './context.js';
import { requireAccess, requireEdit } from './access.js';
import { recordAudit } from './audit.js';
import { syncVersionAfterEdit } from './versions.js';

export interface LoadedTemplate {
  id: string;
  name: string;
  definition: TemplateDefinition;
}

export interface TemplateEvaluation {
  templateId: string | null;
  templateName: string | null;
  definition: TemplateDefinition | null;
  values: TemplateValues;
  /** Visible fields (after conditions). */
  fields: TemplateFieldDef[];
  /** Visible required fields that are blank, blocks finalization flows. */
  missingRequired: MissingRequiredField[];
  /** All visible-field issues (required blanks + format errors). */
  issues: TemplateFieldIssue[];
}

export interface TemplatePreviewResult extends TemplateEvaluation {
  /** Composed sections in document order (visible flag included). */
  sections: RenderedTemplateSection[];
}

/* ------------------------------- loading -------------------------------- */

/** Parse + semantically validate a definition; broken templates never ship. */
export function toValidatedDefinition(
  raw: unknown,
  templateLabel: string,
): TemplateDefinition {
  const parsed = templateDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.internal(`Template "${templateLabel}" has an invalid definition shape.`);
  }
  const structural = parseTemplateDefinition(parsed.data);
  if (!structural) {
    throw AppError.internal(`Template "${templateLabel}" definition could not be parsed.`);
  }
  const problems = findDefinitionProblems(structural);
  if (problems.length > 0) {
    throw AppError.internal(
      `Template "${templateLabel}" definition has problems: ${problems.join(' ')}`,
    );
  }
  return structural;
}

export async function loadDefinition(
  db: Queryable,
  templateId: string,
): Promise<LoadedTemplate | null> {
  const row = await one<{ id: string; name: string; content_schema: unknown }>(
    db,
    `SELECT id, name, content_schema FROM agreement_templates WHERE id = $1`,
    [templateId],
  );
  if (!row) return null;
  return { id: row.id, name: row.name, definition: toValidatedDefinition(row.content_schema, row.name) };
}

/* -------------------------------- values -------------------------------- */

function coerceValue(raw: unknown): TemplateValues[string] {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  // Legacy/odd jsonb shapes are flattened for display rather than crashing.
  return JSON.stringify(raw);
}

/**
 * Stored agreement values with definition defaults filled in for fields that
 * have no row yet (agreements created before a default existed). Explicitly
 * stored values, including empty strings, always win.
 */
export async function getTemplateValues(
  db: Queryable,
  agreementId: string,
  definition: TemplateDefinition,
): Promise<TemplateValues> {
  const rows = await many<{ code: string; value: unknown }>(
    db,
    `SELECT code, value FROM agreement_fields WHERE agreement_id = $1`,
    [agreementId],
  );
  const values: TemplateValues = emptyValues(definition);
  for (const row of rows) values[row.code] = coerceValue(row.value);
  return values;
}

/* ------------------------------ evaluation ------------------------------ */

export async function evaluateTemplate(
  db: Queryable,
  agreementId: string,
  overlay?: TemplateValues,
): Promise<TemplatePreviewResult> {
  const agreement = await one<{ template_id: string | null }>(
    db,
    `SELECT template_id FROM agreements WHERE id = $1`,
    [agreementId],
  );
  if (!agreement) throw AppError.notFound('Agreement not found.');
  if (!agreement.template_id) {
    // Legacy agreement without a template link, nothing to evaluate.
    return {
      templateId: null,
      templateName: null,
      definition: null,
      values: {},
      fields: [],
      missingRequired: [],
      issues: [],
      sections: [],
    };
  }

  const template = await loadDefinition(db, agreement.template_id);
  if (!template) throw AppError.notFound('Template not found.');

  const stored = await getTemplateValues(db, agreementId, template.definition);
  const values: TemplateValues = { ...stored };
  if (overlay) {
    for (const [code, value] of Object.entries(overlay)) {
      if (template.definition.fields.some((f) => f.code === code)) values[code] = value;
    }
  }

  const fields = visibleFields(template.definition, values);
  const issues = validateValues(template.definition, values);
  const missingRequired = findMissingRequired(template.definition, values);
  const sections = renderSections(template.definition, values);

  return {
    templateId: template.id,
    templateName: template.name,
    definition: template.definition,
    values,
    fields,
    missingRequired,
    issues,
    sections,
  };
}

/** Read-only composed preview (never throws on incomplete required fields). */
export async function previewTemplate(
  db: Queryable,
  agreementId: string,
  overlay?: TemplateValues,
): Promise<TemplatePreviewResult> {
  return evaluateTemplate(db, agreementId, overlay);
}

/* ------------------------------- generation ----------------------------- */

export interface GenerateResult extends TemplatePreviewResult {
  persisted: boolean;
}

/**
 * Persist optional field values, then (re)compose working-copy section bodies
 * from the definition + values. Conditional sections get `included` synced to
 * their visibility. Same edit guards as updateDraft: access, DRAFT or
 * NEGOTIATION status, and edit permission.
 */
export async function generateTemplate(
  db: Db,
  ctx: ActorContext,
  agreementId: string,
  overlay?: ZodTemplateValues,
): Promise<GenerateResult> {
  return withTransaction(db, async (tx) => {
    const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);
    if (access.agreement.status !== 'DRAFT' && access.agreement.status !== 'NEGOTIATION') {
      throw AppError.conflict(
        'NOT_DRAFT',
        `Document generation is only allowed in DRAFT/NEGOTIATION status (current: ${access.agreement.status}).`,
      );
    }
    requireEdit(access);
    if (!access.agreement.template_id) {
      throw AppError.conflict('NO_TEMPLATE', 'This agreement has no template to generate from.');
    }

    const template = await loadDefinition(tx, access.agreement.template_id);
    if (!template) throw AppError.notFound('Template not found.');

    // Persist supplied values, but reject malformed ones (required blanks
    // are fine to save mid-edit; wrong types are not).
    const knownCodes = new Set(template.definition.fields.map((f) => f.code));
    const cleaned: TemplateValues = {};
    if (overlay) {
      for (const [code, value] of Object.entries(overlay)) {
        if (knownCodes.has(code)) cleaned[code] = value;
      }
    }
    const stored = await getTemplateValues(tx, agreementId, template.definition);
    const merged: TemplateValues = { ...stored };
    for (const [code, value] of Object.entries(cleaned)) merged[code] = value;

    const formatIssues = validateValues(template.definition, merged).filter(
      (i) => i.kind === 'format',
    );
    if (formatIssues.length > 0) {
      const asFieldErrors: Record<string, string[]> = {};
      for (const issue of formatIssues) {
        (asFieldErrors[issue.code] ??= []).push(issue.message);
      }
      throw AppError.badRequest(
        'TEMPLATE_VALUES_INVALID',
        'Some field values are not valid for their field type.',
        asFieldErrors,
      );
    }

    for (const [code, value] of Object.entries(cleaned)) {
      await exec(
        tx,
        `INSERT INTO agreement_fields (agreement_id, code, value, provenance, updated_by)
         VALUES ($1,$2,$3::jsonb,'USER_PROVIDED',$4)
         ON CONFLICT (agreement_id, code) DO UPDATE
           SET value = EXCLUDED.value,
               provenance = 'USER_PROVIDED',
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [agreementId, code, JSON.stringify(value ?? null), ctx.userId],
      );
    }

    const sections = renderSections(template.definition, merged);
    for (const section of sections) {
      const definition = template.definition.sections.find((s) => s.code === section.code);
      await exec(
        tx,
        `INSERT INTO agreement_sections (agreement_id, code, title, body, order_index, included)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (agreement_id, code) DO UPDATE
           SET body = EXCLUDED.body,
               included = EXCLUDED.included,
               updated_at = now()`,
        [
          agreementId,
          section.code,
          definition?.title ?? section.title,
          section.body,
          section.order,
          section.visible,
        ],
      );
    }

    // Generation rewrites section bodies (and possibly field values), apply
    // the same snapshot policy as every other content writer so the version
    // history always matches the working document: refreshed in place while
    // DRAFT, a brand-new version when the change lands during negotiation.
    const { versionCreated } = await syncVersionAfterEdit(tx, ctx, access);

    const missingRequired = findMissingRequired(template.definition, merged);
    const fields = visibleFields(template.definition, merged);

    await recordAudit(tx, {
      agreementId,
      orgId: access.agreement.org_id,
      eventType: 'AGREEMENT_UPDATED',
      actor: auditActor(ctx),
      metadata: {
        publicId: access.agreement.public_id,
        action: 'template_generate',
        templateId: template.id,
        sections: sections.filter((s) => s.visible).length,
        totalSections: sections.length,
        ...(versionCreated
          ? {
              newVersionNumber: versionCreated.version_number,
              changeSummary: versionCreated.change_summary,
            }
          : {}),
      },
    });

    return {
      templateId: template.id,
      templateName: template.name,
      definition: template.definition,
      values: merged,
      fields,
      missingRequired,
      issues: validateValues(template.definition, merged),
      sections,
      persisted: true,
    };
  });
}

/* --------------------------- finalization gate --------------------------- */

/**
 * Throws 400 MISSING_REQUIRED_FIELDS when visible required template fields
 * are still blank. Called before approval requests, signature requests,
 * transitions into AWAITING_SIGNATURES, and finalization.
 */
export async function assertTemplateComplete(
  db: Queryable,
  agreementId: string,
): Promise<void> {
  const evaluation = await evaluateTemplate(db, agreementId);
  if (!evaluation.definition || evaluation.missingRequired.length === 0) return;
  const labels = evaluation.missingRequired.map((m) => m.label).join(', ');
  throw AppError.badRequest(
    'MISSING_REQUIRED_FIELDS',
    `Complete the required information before finalizing: ${labels}.`,
    { missing: evaluation.missingRequired },
  );
}
