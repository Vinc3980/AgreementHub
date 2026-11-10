/**
 * AI provider abstraction (SPEC: AI assistant, architecture).
 *
 * The application talks to `AiProvider` only; concrete providers
 * (deterministic rules, OpenAI-compatible HTTP, future vendors…) live behind
 * this interface. API keys stay server-side in config, never in the web app.
 *
 * The seam is TASK-LEVEL (extract / explain / review / summarize), not raw
 * text completion: providers receive already-structured facts and return raw
 * feature data. Framing, disclaimers, template mapping, logging, and every
 * safety rule live in services/aiAssistant.ts, so swapping a provider never
 * changes API shapes or safety behavior, and a new vendor implements four
 * methods instead of re-deriving policy.
 */

export interface AiProvider {
  readonly id: string;
  /** Human-readable engine label for the UI, e.g. 'Rules assistant'. */
  readonly label: string;

  /** Feature 1: derive field suggestions from a natural-language brief. */
  extract(input: AiExtractInput): Promise<AiExtractOutput>;

  /** Feature 3: plain-language explanation of one clause. */
  explain(input: AiExplainInput): Promise<AiExplainOutput>;

  /** Feature 2: potentially-missing-information review of a draft. */
  review(input: AiReviewInput): Promise<AiReviewOutput>;

  /** Feature 4: concise summary of an agreement. */
  summarize(input: AiSummaryInput): Promise<AiSummaryOutput>;

  /** Feature 5: questions the user might want to answer in the agreement. */
  questions(input: AiQuestionsInput): Promise<AiQuestionsOutput>;
}

/* ------------------------------- inputs ---------------------------------- */

/** One known field of the target template (or a generic slot). */
export interface AiFieldSpec {
  code: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  guidance?: string;
}

export interface AiExtractInput {
  description: string;
  /** Template fields to map onto (empty ⇒ generic slot names). */
  fields: AiFieldSpec[];
}

export interface AiExplainInput {
  /** Formal clause text to explain. */
  text: string;
  /** Optional agreement title, for phrasing context only. */
  agreementTitle?: string;
}

/** One stored field value of the agreement under review. */
export interface AiFieldValue {
  code: string;
  label: string;
  value: string;
  required: boolean;
}

/** One stored section of the agreement under review. */
export interface AiSectionText {
  code: string;
  title: string;
  body: string;
  included: boolean;
}

export interface AiReviewInput {
  title: string;
  fields: AiFieldValue[];
  sections: AiSectionText[];
}

export interface AiSummaryInput {
  title: string;
  fields: AiFieldValue[];
  sections: AiSectionText[];
}

export interface AiQuestionsInput {
  title: string;
  fields: AiFieldValue[];
  sections: AiSectionText[];
}

/* ------------------------------- outputs --------------------------------- */

export interface AiExtractOutput {
  fields: Array<{
    fieldCode: string;
    label: string;
    value: string;
    confidence: 'high' | 'medium' | 'low';
    /** Short quote of the source text this suggestion is based on. */
    basis?: string;
  }>;
  /** What the provider could not derive, asked of the user, never invented. */
  needsInput: string[];
}

export interface AiExplainOutput {
  plainLanguage: string;
  phrases: Array<{ formal: string; plain: string }>;
}

export interface AiReviewOutput {
  items: Array<{
    fieldCode: string | null;
    label: string;
    detail: string;
    severity: 'important' | 'worth-considering';
  }>;
}

export interface AiSummaryOutput {
  parties: string;
  purpose: string;
  payment: string;
  timeline: string;
  responsibilities: string;
  termination: string;
  importantDates: Array<{ label: string; date: string }>;
}

export interface AiQuestionsOutput {
  questions: Array<{ text: string; fieldCode: string | null }>;
}
