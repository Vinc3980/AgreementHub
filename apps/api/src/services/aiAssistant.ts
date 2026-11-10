/**
 * AI assistant service, the policy layer between routes and AI providers.
 *
 * Everything safety-critical lives HERE, not in providers:
 *  - responses always carry the fixed disclaimer + `aiGenerated: true`;
 *  - review output is always framed as "Potentially missing information";
 *  - extraction returns SUGGESTIONS ONLY. This service never writes to an
 *    agreement. Applying a suggestion is a normal user PATCH with provenance
 *    `AI_SUGGESTED_CONFIRMED`, so the audit trail shows exactly what the AI
 *    proposed and the user confirmed; finalized agreements stay immutable
 *    because that PATCH is guarded by DRAFT/NEGOTIATION like any edit.
 *  - requests are logged with METADATA ONLY (feature, provider, model,
 *    duration, counts), never the description text or agreement content.
 */
import { AppError } from '@agreementhub/domain';
import {
  AI_DISCLAIMER,
  AI_REVIEW_HEADING,
  type AiExtractResponse,
  type AiExplainResponse,
  type AiQuestionsResponse,
  type AiReviewResponse,
  type AiSummaryResponse,
} from '@agreementhub/contracts';
import type { AiProvider, AiFieldSpec, AiFieldValue, AiSectionText } from '../ai/types.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { loadDefinition } from './templateEngine.js';
import { parseTemplateDefinition } from '@agreementhub/domain/template';

export interface AssistantLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** Wrap a provider call: time it, log metadata (never content), re-throw. */
async function timed<T>(
  log: AssistantLogger,
  feature: string,
  provider: AiProvider,
  meta: Record<string, unknown>,
  call: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await call();
    log.info({ feature, provider: provider.id, durationMs: Date.now() - started, ok: true, ...meta }, 'ai assistant request');
    return result;
  } catch (err) {
    log.warn(
      {
        feature,
        provider: provider.id,
        durationMs: Date.now() - started,
        ok: false,
        code: err instanceof AppError ? err.code : 'UNKNOWN',
        ...meta,
      },
      'ai assistant request failed',
    );
    throw err;
  }
}

function brief(provider: AiProvider): { disclaimer: string; aiGenerated: true; provider: string; providerLabel: string } {
  return {
    disclaimer: AI_DISCLAIMER,
    aiGenerated: true,
    provider: provider.id,
    providerLabel: provider.label,
  };
}

/* ---------------------------- shared loading ------------------------------ */

interface AgreementContext {
  id: string;
  title: string;
  templateId: string | null;
  status: string;
}

/**
 * Load one agreement's identity for assistant features. Callers have already
 * checked read access (routes use requireAccess), so this is only fetching
 * content for a viewer who may see the agreement anyway.
 */
async function loadAgreementContext(db: Queryable, agreementId: string): Promise<AgreementContext> {
  const row = await one<{ id: string; title: string; template_id: string | null; status: string }>(
    db,
    `SELECT id, title, template_id, status FROM agreements WHERE id = $1 AND deleted_at IS NULL`,
    [agreementId],
  );
  if (!row) throw AppError.notFound('Agreement not found.');
  return { id: row.id, title: row.title, templateId: row.template_id, status: row.status };
}

/** Field values (with labels from the template when available). */
async function loadFieldValues(db: Queryable, agreementId: string, templateId: string | null): Promise<AiFieldValue[]> {
  const rows = await many<{ code: string; value: unknown }>(
    db,
    `SELECT code, value FROM agreement_fields WHERE agreement_id = $1 ORDER BY code`,
    [agreementId],
  );
  const labels = new Map<string, { label: string; required: boolean }>();
  if (templateId) {
    const template = await loadDefinition(db, templateId);
    for (const f of template?.definition.fields ?? []) {
      labels.set(f.code, { label: f.label, required: f.required === true });
    }
  }
  return rows.map((r) => ({
    code: r.code,
    label: labels.get(r.code)?.label ?? r.code,
    value: r.value === null || r.value === undefined ? '' : String(r.value),
    required: labels.get(r.code)?.required ?? false,
  }));
}

async function loadSections(db: Queryable, agreementId: string): Promise<AiSectionText[]> {
  const rows = await many<{ code: string; title: string; body: string; included: boolean }>(
    db,
    `SELECT code, title, body, included FROM agreement_sections WHERE agreement_id = $1 ORDER BY order_index`,
    [agreementId],
  );
  return rows.map((r) => ({ code: r.code, title: r.title, body: r.body ?? '', included: r.included }));
}

/* ----------------------------- feature 1 --------------------------------- */

/**
 * Feature 1, plain language → field suggestions. READ-ONLY: nothing is
 * written to any agreement; the user confirms each suggestion via PATCH.
 */
export async function extractFields(
  db: Queryable,
  provider: AiProvider,
  log: AssistantLogger,
  input: { description: string; templateId?: string },
): Promise<AiExtractResponse> {
  let specs: AiFieldSpec[] = [];
  let templateId: string | null = null;
  if (input.templateId) {
    const template = await loadDefinition(db, input.templateId);
    if (!template) throw AppError.notFound('Template not found.');
    templateId = template.id;
    // Only fields a user could reasonably fill from a description.
    specs = template.definition.fields.map((f) => ({
      code: f.code,
      label: f.label,
      type: f.type,
      required: f.required === true,
      options: f.options,
      guidance: f.guidance,
    }));
  }

  const output = await timed(log, 'extract', provider, { templateId, chars: input.description.length }, () =>
    provider.extract({ description: input.description, fields: specs }),
  );

  // Clamp to known template codes (never suggest fields that don't exist).
  const known = new Set(specs.map((s) => s.code));
  const fields = output.fields.filter((f) => specs.length === 0 || known.has(f.fieldCode)).slice(0, 40);

  return { ...brief(provider), templateId, fields, needsInput: output.needsInput.slice(0, 12) };
}

/* ----------------------------- features 2/5 ------------------------------- */

export async function reviewAgreement(
  db: Queryable,
  provider: AiProvider,
  log: AssistantLogger,
  agreementId: string,
): Promise<AiReviewResponse> {
  const ctx = await loadAgreementContext(db, agreementId);
  const [fields, sections] = await Promise.all([
    loadFieldValues(db, agreementId, ctx.templateId),
    loadSections(db, agreementId),
  ]);
  const output = await timed(log, 'review', provider, { agreementId, fields: fields.length, sections: sections.length }, () =>
    provider.review({ title: ctx.title, fields, sections }),
  );
  return {
    ...brief(provider),
    heading: AI_REVIEW_HEADING,
    items: output.items.slice(0, 12),
  };
}

export async function suggestQuestions(
  db: Queryable,
  provider: AiProvider,
  log: AssistantLogger,
  agreementId: string,
): Promise<AiQuestionsResponse> {
  const ctx = await loadAgreementContext(db, agreementId);
  const [fields, sections] = await Promise.all([
    loadFieldValues(db, agreementId, ctx.templateId),
    loadSections(db, agreementId),
  ]);
  const output = await timed(log, 'questions', provider, { agreementId, fields: fields.length, sections: sections.length }, () =>
    provider.questions({ title: ctx.title, fields, sections }),
  );
  return { ...brief(provider), questions: output.questions.slice(0, 10) };
}

/* ----------------------------- feature 3 --------------------------------- */

export async function explainClause(
  db: Queryable,
  provider: AiProvider,
  log: AssistantLogger,
  input: { agreementId: string; text?: string; sectionCode?: string },
): Promise<AiExplainResponse> {
  const ctx = await loadAgreementContext(db, input.agreementId);

  let text = input.text ?? '';
  if (!text && input.sectionCode) {
    // Section bodies are fetched server-side, the client only names the
    // section, so an altered request can't make us explain other content.
    const section = await one<{ body: string; title: string }>(
      db,
      `SELECT title, body FROM agreement_sections WHERE agreement_id = $1 AND code = $2`,
      [input.agreementId, input.sectionCode],
    );
    if (!section) throw AppError.notFound('Section not found in this agreement.');
    text = section.body;
  }
  text = text.trim().slice(0, 2000);
  if (!text) throw AppError.badRequest('EMPTY_CLAUSE', 'There is no text to explain.');

  const output = await timed(log, 'explain', provider, { agreementId: input.agreementId, chars: text.length }, () =>
    provider.explain({ text, agreementTitle: ctx.title }),
  );

  return {
    ...brief(provider),
    formalText: text,
    plainLanguage: output.plainLanguage,
    phrases: output.phrases,
    notLegalAdvice: true,
  };
}

/* ----------------------------- feature 4 --------------------------------- */

export async function summarizeAgreement(
  db: Queryable,
  provider: AiProvider,
  log: AssistantLogger,
  agreementId: string,
): Promise<AiSummaryResponse> {
  const ctx = await loadAgreementContext(db, agreementId);
  const [fields, sections] = await Promise.all([
    loadFieldValues(db, agreementId, ctx.templateId),
    loadSections(db, agreementId),
  ]);
  const output = await timed(log, 'summarize', provider, { agreementId, fields: fields.length, sections: sections.length }, () =>
    provider.summarize({ title: ctx.title, fields, sections }),
  );
  return { ...brief(provider), ...output };
}
