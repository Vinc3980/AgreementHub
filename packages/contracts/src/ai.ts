/**
 * AI Agreement Assistant contracts (SPEC: AI assistant stage).
 *
 * Safety model encoded here:
 *  - every response carries a fixed `disclaimer` and `aiGenerated: true`;
 *  - extraction is SUGGESTIONS ONLY, applying them goes through the normal
 *    agreement PATCH with provenance `AI_SUGGESTED_CONFIRMED` (the API never
 *    writes AI output on its own, and never past DRAFT/NEGOTIATION);
 *  - review output is framed as "Potentially missing information", never as
 *    a legal verdict.
 */
import { z } from 'zod';

/* ------------------------------ shared bits ------------------------------ */

/** Fixed disclaimer shown with every AI result. Never varies by provider. */
export const AI_DISCLAIMER =
  'AI-generated assistance. Review carefully. This is not legal advice.';

/** Label required on review results (never stronger language). */
export const AI_REVIEW_HEADING = 'Potentially missing information';

export const aiConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type AiConfidence = z.infer<typeof aiConfidenceSchema>;

const brief = z.object({
  disclaimer: z.string(),
  aiGenerated: z.literal(true),
  /** Which backend produced this ('rules' | provider id). Shown in the UI. */
  provider: z.string(),
  /** Human-readable engine label ('Rules assistant', 'GPT-4o mini', …). */
  providerLabel: z.string(),
});

/* --------------------- feature 1: plain language → fields ---------------- */

export const aiExtractRequestSchema = z.object({
  /** Natural-language description of the agreement (user-typed). */
  description: z.string().trim().min(10, 'Describe the agreement in a sentence or two.').max(4000),
  /** Optional template to map suggestions onto its field codes. */
  templateId: z.string().uuid().optional(),
});
export type AiExtractRequest = z.infer<typeof aiExtractRequestSchema>;

export const aiExtractedFieldSchema = z.object({
  /** Template field code when a template was given, else a generic key. */
  fieldCode: z.string(),
  label: z.string(),
  /** Extracted value as text (the user confirms/edits before it is applied). */
  value: z.string(),
  confidence: aiConfidenceSchema,
  /** Short quote from the description this suggestion is based on. */
  basis: z.string().optional(),
});
export type AiExtractedField = z.infer<typeof aiExtractedFieldSchema>;

export const aiExtractResponseSchema = brief.extend({
  /** Template the suggestions were mapped to, if any. */
  templateId: z.string().nullable(),
  fields: z.array(aiExtractedFieldSchema),
  /** Notes about what could NOT be derived (asks the user to fill in). */
  needsInput: z.array(z.string()),
});
export type AiExtractResponse = z.infer<typeof aiExtractResponseSchema>;

/* ------------------- feature 2/5: review + suggested questions ----------- */

export const aiReviewItemSchema = z.object({
  /** Related template field code when applicable. */
  fieldCode: z.string().nullable(),
  label: z.string(),
  detail: z.string(),
  severity: z.enum(['important', 'worth-considering']),
});
export type AiReviewItem = z.infer<typeof aiReviewItemSchema>;

export const aiReviewResponseSchema = brief.extend({
  heading: z.literal(AI_REVIEW_HEADING),
  items: z.array(aiReviewItemSchema),
});
export type AiReviewResponse = z.infer<typeof aiReviewResponseSchema>;

export const aiQuestionSchema = z.object({
  text: z.string(),
  /** Field the question points at, if any (UI can jump the user there). */
  fieldCode: z.string().nullable(),
});
export type AiQuestion = z.infer<typeof aiQuestionSchema>;

export const aiQuestionsResponseSchema = brief.extend({
  questions: z.array(aiQuestionSchema),
});
export type AiQuestionsResponse = z.infer<typeof aiQuestionsResponseSchema>;

/* -------------------------- feature 3: explain --------------------------- */

export const aiExplainRequestSchema = z.object({
  agreementId: z.string().uuid(),
  /** Clause text to explain: either raw text… */
  text: z.string().trim().min(3).max(2000).optional(),
  /** …or a section of the agreement (body fetched server-side). */
  sectionCode: z.string().min(1).max(64).optional(),
}).refine((v) => Boolean(v.text) || Boolean(v.sectionCode), {
  message: 'Provide either text or a sectionCode to explain.',
});
export type AiExplainRequest = z.infer<typeof aiExplainRequestSchema>;

export const aiExplainResponseSchema = brief.extend({
  /** The formal text that was explained (echoed for the UI's two-column view). */
  formalText: z.string(),
  /** One or two plain-language sentences. */
  plainLanguage: z.string(),
  /** Key phrases broken out ("formal → plain"). */
  phrases: z.array(z.object({ formal: z.string(), plain: z.string() })),
  /** Always true, the UI renders it prominently. */
  notLegalAdvice: z.literal(true),
});
export type AiExplainResponse = z.infer<typeof aiExplainResponseSchema>;

/* -------------------------- feature 4: summary --------------------------- */

export const aiSummaryResponseSchema = brief.extend({
  parties: z.string(),
  purpose: z.string(),
  payment: z.string(),
  timeline: z.string(),
  responsibilities: z.string(),
  termination: z.string(),
  importantDates: z.array(z.object({ label: z.string(), date: z.string() })),
});
export type AiSummaryResponse = z.infer<typeof aiSummaryResponseSchema>;
