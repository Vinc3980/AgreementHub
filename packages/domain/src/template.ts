/**
 * Template Engine (pure, no I/O, no dependencies).
 *
 * Single source of truth for evaluating agreement template definitions,
 * used by BOTH the API (validation gates, document generation) and the web
 * UI (dynamic form rendering, conditional visibility, live preview).
 *
 * Definition shape (stored in `agreement_templates.content_schema`):
 *
 * ```jsonc
 * {
 *   "definitionVersion": 1,
 *   "sections": [
 *     { "code": "deposit", "title": "Security Deposit", "order": 5,
 *       "required": true, "guidance": "…edit notes…",
 *       "showIf": { "field": "deposit_required", "equals": "YES" },
 *       "body": "The Tenant pays {{field:deposit_amount}}…" }
 *   ],
 *   "fields": [
 *     { "code": "deposit_required", "label": "Security deposit?", "type": "toggle",
 *       "required": true, "default": "NO", "options": ["NO", "YES"],
 *       "guidance": "…help text shown under the label…",
 *       "group": "Property & payment",
 *       "showIf": { "field": "rent_amount", "equals": "0" } }
 *   ]
 * }
 * ```
 *
 * Conditional logic: `showIf: { field, equals }`, visible when the stored
 * value of `field` equals `equals` (case-insensitive for strings; booleans
 * treat "YES"/"true"/true as true). One level of nesting only; a condition
 * referencing an unknown field hides the dependent item (see
 * `findDefinitionProblems`, which tests assert to be empty for all seeds).
 *
 * Rendering: section bodies use `{{field:CODE}}` placeholders. Interpolation
 * produces PLAIN TEXT, escaping/application to HTML/PDF happens downstream
 * (the HTML renderer and a future PDF generator), never here. The engine is
 * deliberately decoupled from any output format.
 */
import { amountInWords, getCurrency, isValidGhanaPhone, parseMoneyAmount, validateMoneyValue } from './currency.js';
import { isValidGhanaPostGps } from './location.js';

export type TemplateFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'date'
  | 'email'
  | 'select'
  | 'toggle';

export type TemplateConditionValue = string | number | boolean;

export interface TemplateShowIf {
  field: string;
  equals: TemplateConditionValue;
}

export interface TemplateFieldDef {
  code: string;
  label: string;
  type: TemplateFieldType;
  /** Visible + required fields block submission/finalization when blank. */
  required?: boolean;
  /** Allowed values for `select`. */
  options?: string[];
  /** Help text rendered beneath the label. */
  guidance?: string;
  placeholder?: string;
  /** Form group heading; fields keep definition order within a group. */
  group?: string;
  /** Seeded into stored values at agreement creation when present. */
  default?: TemplateConditionValue;
  showIf?: TemplateShowIf;
  /** Optional format constraint (e.g. Ghana phone, Ghana Post GPS digital address). */
  format?: 'ghana_phone' | 'ghana_post_gps';
}

export interface TemplateSectionDef {
  code: string;
  title: string;
  order?: number;
  /** Excluded from the generated document when false or conditionally hidden. */
  required?: boolean;
  /** Author guidance shown while editing (never part of the document). */
  guidance?: string;
  showIf?: TemplateShowIf;
  /** Template text containing `{{field:CODE}}` placeholders. */
  body?: string;
}

export interface TemplateDefinition {
  definitionVersion?: number;
  sections: TemplateSectionDef[];
  fields: TemplateFieldDef[];
}

export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateValues = Record<string, TemplateValue>;

export interface RenderedTemplateSection {
  code: string;
  title: string;
  body: string;
  order: number;
  visible: boolean;
}

export interface TemplateFieldIssue {
  code: string;
  label: string;
  message: string;
  /** `required` = blank but required (blocks finalization); `format` = invalid value type. */
  kind: 'required' | 'format';
}

export interface MissingRequiredField {
  code: string;
  label: string;
}

/** Blank marker used for unfilled OPTIONAL placeholders in previews. */
export const BLANK_FILLER = '________';

const FIELD_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{\s*field:\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ----------------------------- construction ---------------------------- */

/**
 * Structural parse of a stored definition. Returns null when the raw value
 * is not a usable definition (shape errors only, semantic problems are
 * reported by `findDefinitionProblems`).
 */
export function parseTemplateDefinition(raw: unknown): TemplateDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const sections = obj.sections;
  const fields = obj.fields;
  if (!Array.isArray(sections) || !Array.isArray(fields)) return null;

  const out: TemplateDefinition = {
    definitionVersion:
      typeof obj.definitionVersion === 'number' && Number.isInteger(obj.definitionVersion)
        ? obj.definitionVersion
        : 1,
    sections: [],
    fields: [],
  };

  for (const s of sections) {
    if (typeof s !== 'object' || s === null) return null;
    const sec = s as Record<string, unknown>;
    if (typeof sec.code !== 'string' || typeof sec.title !== 'string') return null;
    out.sections.push(sec as unknown as TemplateSectionDef);
  }
  for (const f of fields) {
    if (typeof f !== 'object' || f === null) return null;
    const field = f as Record<string, unknown>;
    if (typeof field.code !== 'string' || typeof field.label !== 'string') return null;
    if (typeof field.type !== 'string') return null;
    out.fields.push(field as unknown as TemplateFieldDef);
  }
  return out;
}

/** Default values declared by the definition (used at creation time). */
export function emptyValues(definition: TemplateDefinition): TemplateValues {
  const values: TemplateValues = {};
  for (const field of definition.fields) {
    if (field.default !== undefined) values[field.code] = field.default;
  }
  return values;
}

/* ----------------------------- conditions ------------------------------ */

function conditionMatches(actual: TemplateValue, expected: TemplateConditionValue): boolean {
  if (typeof expected === 'boolean') {
    const truthy =
      actual === true ||
      (typeof actual === 'string' && ['yes', 'true', '1'].includes(actual.trim().toLowerCase()));
    return expected ? truthy : !truthy;
  }
  if (typeof expected === 'number') {
    const n = Number(actual);
    return Number.isFinite(n) && n === expected;
  }
  const a = String(actual ?? '')
    .trim()
    .toLowerCase();
  return a === expected.trim().toLowerCase();
}

export function isFieldVisible(field: TemplateFieldDef, values: TemplateValues): boolean {
  if (!field.showIf) return true;
  // A condition referencing an unknown field reads as undefined, hidden for
  // any non-empty expectation (semantic problems are flagged separately by
  // `findDefinitionProblems`).
  return conditionMatches(values[field.showIf.field], field.showIf.equals);
}

export function isSectionVisible(section: TemplateSectionDef, values: TemplateValues): boolean {
  if (!section.showIf) return true;
  return conditionMatches(values[section.showIf.field], section.showIf.equals);
}

export function visibleFields(
  definition: TemplateDefinition,
  values: TemplateValues,
): TemplateFieldDef[] {
  return definition.fields.filter((f) => isFieldVisible(f, values));
}

export function visibleSections(
  definition: TemplateDefinition,
  values: TemplateValues,
): TemplateSectionDef[] {
  return definition.sections
    .filter((s) => isSectionVisible(s, values))
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/* ----------------------------- validation ------------------------------ */

export function isBlank(value: TemplateValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function numericValue(value: TemplateValue): number | null {
  return parseMoneyAmount(value);
}

/** Resolve the currency code that applies to a money field (sibling currency field). */
export function resolveCurrencyCode(
  field: TemplateFieldDef,
  definition: TemplateDefinition,
  values: TemplateValues,
): string | null {
  // Prefer a field in the same group whose code includes "currency".
  const sameGroup = definition.fields.filter(
    (f) => f !== field && f.type === 'select' && /currency/i.test(f.code) && f.group === field.group,
  );
  const candidates = sameGroup.length
    ? sameGroup
    : definition.fields.filter((f) => f !== field && f.type === 'select' && /currency/i.test(f.code));
  for (const c of candidates) {
    const v = values[c.code];
    if (!isBlank(v)) return String(v).trim().toUpperCase();
    if (c.default != null) return String(c.default).trim().toUpperCase();
  }
  return null;
}

/**
 * Per-field validation for VISIBLE fields: required blanks, plus type/format
 * checks. Money rejects negatives, non-numbers and >2 decimals (accepts
 * grouped/pasted values). Ghana phone format is enforced when declared.
 * The API treats issues on required fields as blocking; the UI shows all.
 */
export function validateValues(
  definition: TemplateDefinition,
  values: TemplateValues,
): TemplateFieldIssue[] {
  const issues: TemplateFieldIssue[] = [];
  for (const field of visibleFields(definition, values)) {
    const value = values[field.code];
    const required = field.required === true;

    if (isBlank(value)) {
      if (required)
        issues.push({
          code: field.code,
          label: field.label,
          message: `${field.label} is required.`,
          kind: 'required',
        });
      continue;
    }

    let message: string | null = null;
    switch (field.type) {
      case 'number':
        if (numericValue(value) === null) message = `${field.label} must be a number.`;
        break;
      case 'money': {
        const err = validateMoneyValue(value, 2);
        if (err) message = `${field.label} ${err}.`;
        break;
      }
      case 'date':
        if (!DATE_RE.test(String(value)) || Number.isNaN(Date.parse(String(value)))) {
          message = `${field.label} must be a valid date (YYYY-MM-DD).`;
        }
        break;
      case 'email':
        if (!EMAIL_RE.test(String(value).trim())) message = `${field.label} must be a valid email address.`;
        break;
      case 'select':
        if (field.options && field.options.length > 0 && !field.options.includes(String(value))) {
          message = `${field.label} must be one of the allowed options.`;
        }
        break;
      default:
        break;
    }
    if (!message && field.format === 'ghana_phone' && !isValidGhanaPhone(value)) {
      message = `${field.label} must be a valid Ghana phone number (e.g. 024 123 4567 or +233 24 123 4567).`;
    }
    if (!message && field.format === 'ghana_post_gps' && !isValidGhanaPostGps(value)) {
      message = `${field.label} must be a valid Ghana Post GPS digital address (e.g. GA-123-4567).`;
    }
    if (message) issues.push({ code: field.code, label: field.label, message, kind: 'format' });
  }
  return issues;
}

/**
 * Required-and-blank check used to block approval requests, signature
 * requests, transitions into signing, and finalization.
 */
export function findMissingRequired(
  definition: TemplateDefinition,
  values: TemplateValues,
): MissingRequiredField[] {
  const missing: MissingRequiredField[] = [];
  for (const field of visibleFields(definition, values)) {
    if (field.required === true && isBlank(values[field.code])) {
      missing.push({ code: field.code, label: field.label });
    }
  }
  return missing;
}

/* ------------------------------ rendering ------------------------------ */

function formatValue(
  field: TemplateFieldDef,
  value: TemplateValue,
  ctx?: { definition: TemplateDefinition; values: TemplateValues },
): string {
  if (isBlank(value)) return BLANK_FILLER;
  if (field.type === 'toggle') {
    const truthy =
      value === true ||
      (typeof value === 'string' && ['yes', 'true', '1'].includes(value.trim().toLowerCase()));
    return truthy ? 'Yes' : 'No';
  }
  if (field.type === 'number') {
    const n = numericValue(value);
    return n === null ? String(value) : String(n);
  }
  if (field.type === 'money') {
    const n = numericValue(value);
    if (n === null) return String(value);
    // In rendered documents, money is shown with the ISO currency code and
    // amount-in-words for legal clarity (e.g. "GHS 5,000.00 (Five Thousand
    // Ghana Cedis)"). This only affects newly generated/composed sections;
    // v1 agreements keep their already-stored section bodies unchanged.
    if (ctx) {
      const currency = resolveCurrencyCode(field, ctx.definition, ctx.values);
      if (currency) return amountInWords(n, currency);
      // No resolvable currency: render a plain grouped amount (no code guess).
      const def = getCurrency('USD');
      void def;
      return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: true,
      }).format(n);
    }
    return String(n);
  }
  return String(value);
}

/**
 * Replace `{{field:CODE}}` placeholders with formatted values. Output is
 * plain text; escaping happens in the HTML renderer, conversion in PDF.
 */
export function interpolate(
  body: string,
  definition: TemplateDefinition,
  values: TemplateValues,
): string {
  const index = new Map(definition.fields.map((f) => [f.code, f]));
  const ctx = { definition, values };
  return body.replace(PLACEHOLDER_RE, (_match, code: string) => {
    const field = index.get(code);
    if (!field) return '';
    return formatValue(field, values[code], ctx);
  });
}

/** Evaluate the definition against stored values into render-ready sections. */
export function renderSections(
  definition: TemplateDefinition,
  values: TemplateValues,
): RenderedTemplateSection[] {
  const index = new Map(definition.fields.map((f) => [f.code, f]));
  const ctx = { definition, values };
  return definition.sections
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((section) => {
      const body = (section.body ?? '').replace(PLACEHOLDER_RE, (_m, code: string) => {
        const field = index.get(code);
        if (!field) return '';
        return formatValue(field, values[code], ctx);
      });
      return {
        code: section.code,
        title: section.title,
        body,
        order: section.order ?? 0,
        visible: isSectionVisible(section, values),
      };
    });
}

/** Field codes whose `{{field:}}` placeholders are defined (for form seeding). */
export function referencedFieldCodes(body: string): string[] {
  const codes: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  while ((match = re.exec(body)) !== null) {
    const code = match[1];
    if (code) codes.push(code);
  }
  return codes;
}

/* -------------------------- definition integrity ------------------------ */

/**
 * Semantic problems in a definition (independent of any stored values).
 * Tests assert this is empty for every seeded template; the API throws on
 * templates that fail it so broken definitions never reach users.
 */
export function findDefinitionProblems(definition: TemplateDefinition): string[] {
  const problems: string[] = [];
  const fieldCodes = new Set<string>();
  const sectionCodes = new Set<string>();

  if (definition.sections.length === 0) problems.push('Template has no sections.');
  if (definition.fields.length === 0) problems.push('Template has no fields.');

  for (const field of definition.fields) {
    if (!FIELD_CODE_RE.test(field.code)) problems.push(`Invalid field code "${field.code}".`);
    if (fieldCodes.has(field.code)) problems.push(`Duplicate field code "${field.code}".`);
    fieldCodes.add(field.code);
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
      problems.push(`Select field "${field.code}" has no options.`);
    }
    if (
      field.default !== undefined &&
      field.options &&
      field.options.length > 0 &&
      !field.options.includes(String(field.default))
    ) {
      problems.push(`Default of "${field.code}" is not one of its options.`);
    }
    if (field.showIf && !FIELD_CODE_RE.test(field.showIf.field)) {
      problems.push(`Field "${field.code}" has an invalid condition field code.`);
    }
  }

  for (const section of definition.sections) {
    if (!FIELD_CODE_RE.test(section.code)) problems.push(`Invalid section code "${section.code}".`);
    if (sectionCodes.has(section.code)) problems.push(`Duplicate section code "${section.code}".`);
    sectionCodes.add(section.code);
    if (section.showIf && !FIELD_CODE_RE.test(section.showIf.field)) {
      problems.push(`Section "${section.code}" has an invalid condition field code.`);
    }
  }

  // Conditions and placeholders must reference defined fields.
  const refProblem = (owner: string, code: string) =>
    problems.push(`${owner} references unknown field "${code}".`);
  for (const field of definition.fields) {
    if (field.showIf && !fieldCodes.has(field.showIf.field)) {
      refProblem(`Field "${field.code}" condition`, field.showIf.field);
    }
  }
  for (const section of definition.sections) {
    if (section.showIf && !fieldCodes.has(section.showIf.field)) {
      refProblem(`Section "${section.code}" condition`, section.showIf.field);
    }
    for (const code of referencedFieldCodes(section.body ?? '')) {
      if (!fieldCodes.has(code)) refProblem(`Section "${section.code}" body`, code);
    }
  }

  return problems;
}
