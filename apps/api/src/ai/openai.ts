/**
 * OpenAiProvider, OpenAI-compatible chat-completions backend for the
 * assistant (works with OpenAI or any compatible gateway via base URL).
 *
 * Safety/policy is NOT implemented here: prompts carry the fixed rules
 * (never invent facts, no legal advice, JSON only), and the assistant
 * service re-validates and re-frames everything on the way out. Keys stay
 * server-side; requests are logged by the service with metadata only.
 *
 * Uses Node's built-in fetch, no extra dependency.
 */
import { AppError } from '@agreementhub/domain';
import type {
  AiExplainInput,
  AiExplainOutput,
  AiExtractInput,
  AiExtractOutput,
  AiProvider,
  AiQuestionsInput,
  AiQuestionsOutput,
  AiReviewInput,
  AiReviewOutput,
  AiSummaryInput,
  AiSummaryOutput,
} from './types.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  /** e.g. https://api.openai.com/v1 (or a compatible gateway). */
  baseUrl: string;
  model: string;
  /** Per-request timeout; provider calls never hang a request forever. */
  timeoutMs?: number;
}

const SAFETY_PREAMBLE = `You are the AgreementHub drafting assistant. Hard rules:
- Use ONLY the information provided. Never invent names, amounts, dates, or facts. If something is unknown, leave it out and list it as needing input.
- You are not a lawyer. Never claim the agreement is legally valid, enforceable, or compliant. Never give personalized legal advice.
- Return ONLY a JSON object matching the requested shape. No prose, no markdown fences, no comments.`;

export class OpenAiProvider implements AiProvider {
  readonly id = 'openai';
  readonly label: string;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.label = options.model;
  }

  private async chat(system: string, user: string, maxTokens = 900): Promise<unknown> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new AppError(
          502,
          'AI_PROVIDER_ERROR',
          `The AI provider responded with ${res.status}. Try again shortly.`,
          { provider: this.id, detail: body.slice(0, 200) },
        );
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new AppError(502, 'AI_PROVIDER_ERROR', 'The AI provider returned an empty response.', { provider: this.id });
      }
      return parseJson(content);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new AppError(504, 'AI_PROVIDER_TIMEOUT', 'The AI provider timed out. Try again.', { provider: this.id });
      }
      throw new AppError(502, 'AI_PROVIDER_ERROR', 'The AI provider could not be reached. Try again shortly.', {
        provider: this.id,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async extract(input: AiExtractInput): Promise<AiExtractOutput> {
    const fieldList = input.fields
      .map((f) => `- ${f.code} (${f.label}, type ${f.type}${f.options ? `, options: ${f.options.join(' | ')}` : ''})`)
      .join('\n');
    const raw = (await this.chat(
      SAFETY_PREAMBLE,
      `Task: extract agreement facts from the user's description.
Target fields (use these exact fieldCode values, only when the description supports them):
${fieldList || '- generic slots: client, service, price, currency, payment_schedule, revision_limit, maintenance'}

Description:
"""
${input.description}
"""

Respond with JSON:
{"fields":[{"fieldCode":"...","label":"...","value":"...","confidence":"high|medium|low","basis":"short quote from the description"}],
 "needsInput":["short question for anything essential that was NOT mentioned"]}
For select-type fields, the value must be one of the listed options; if unsure, put the field in needsInput instead.`,
      1200,
    )) as { fields?: unknown; needsInput?: unknown };
    return {
      fields: asArray(raw.fields)
        .filter((f) => isRecord(f) && typeof f.fieldCode === 'string' && typeof f.value === 'string')
        .slice(0, 40)
        .map((f) => ({
          fieldCode: String(f.fieldCode),
          label: typeof f.label === 'string' ? f.label : String(f.fieldCode),
          value: String(f.value).slice(0, 2000),
          confidence: f.confidence === 'high' || f.confidence === 'low' ? f.confidence : 'medium',
          basis: typeof f.basis === 'string' ? f.basis.slice(0, 200) : undefined,
        })),
      needsInput: asArray(raw.needsInput).map((s) => String(s).slice(0, 200)).slice(0, 12),
    };
  }

  async explain(input: AiExplainInput): Promise<AiExplainOutput> {
    const raw = (await this.chat(
      SAFETY_PREAMBLE,
      `Task: explain one agreement clause in everyday language for a non-lawyer.
Do not assess legality or give advice; describe what the clause says and does.

Clause:
"""
${input.text.slice(0, 2000)}
"""

Respond with JSON:
{"plainLanguage":"2-3 sentences of plain language","phrases":[{"formal":"as written","plain":"everyday meaning"}]}`,
      700,
    )) as { plainLanguage?: unknown; phrases?: unknown };
    return {
      plainLanguage:
        typeof raw.plainLanguage === 'string' && raw.plainLanguage.trim()
          ? raw.plainLanguage.trim().slice(0, 1200)
          : 'The assistant could not summarize this clause. Read it alongside the specific numbers and dates it references.',
      phrases: asArray(raw.phrases)
        .filter((p) => isRecord(p) && typeof p.formal === 'string' && typeof p.plain === 'string')
        .slice(0, 10)
        .map((p) => ({ formal: String(p.formal).slice(0, 120), plain: String(p.plain).slice(0, 300) })),
    };
  }

  async review(input: AiReviewInput): Promise<AiReviewOutput> {
    const raw = (await this.chat(
      SAFETY_PREAMBLE,
      `Task: list information that is POTENTIALLY MISSING from this agreement draft.
Never say anything is illegal, invalid, or unenforceable. Frame everything as something the user may want to consider adding.

Title: ${input.title}
Fields:
${input.fields.map((f) => `- ${f.label} (${f.code}${f.required ? ', required' : ''}): ${f.value || '(empty)'}`).join('\n')}
Sections:
${input.sections.filter((s) => s.included).map((s) => `## ${s.title}\n${s.body.slice(0, 600)}`).join('\n\n').slice(0, 6000)}

Respond with JSON:
{"items":[{"fieldCode":"code or null","label":"short topic","detail":"one sentence on what to consider and why it matters to the parties","severity":"important|worth-considering"}]}
Only list items that are genuinely absent or blank. Maximum 10 items.`,
      900,
    )) as { items?: unknown };
    return {
      items: asArray(raw.items)
        .filter((i) => isRecord(i) && typeof i.label === 'string')
        .slice(0, 12)
        .map((i) => ({
          fieldCode: typeof i.fieldCode === 'string' ? i.fieldCode : null,
          label: String(i.label).slice(0, 120),
          detail: typeof i.detail === 'string' ? i.detail.slice(0, 400) : '',
          severity: i.severity === 'worth-considering' ? 'worth-considering' : 'important',
        })),
    };
  }

  async summarize(input: AiSummaryInput): Promise<AiSummaryOutput> {
    const raw = (await this.chat(
      SAFETY_PREAMBLE,
      `Task: summarize this agreement draft concisely, using only what is written.
Do not add facts. If something is absent, say it is not stated.

Title: ${input.title}
Fields:
${input.fields.map((f) => `- ${f.label}: ${f.value || '(empty)'}`).join('\n')}
Sections:
${input.sections.filter((s) => s.included).map((s) => `## ${s.title}\n${s.body.slice(0, 600)}`).join('\n\n').slice(0, 6000)}

Respond with JSON:
{"parties":"...","purpose":"...","payment":"...","timeline":"...","responsibilities":"...","termination":"...",
 "importantDates":[{"label":"...","date":"YYYY-MM-DD or as written"}]}`,
      900,
    )) as Record<string, unknown>;
    const pick = (key: string, fallback: string): string =>
      typeof raw[key] === 'string' && (raw[key] as string).trim()
        ? (raw[key] as string).trim().slice(0, 600)
        : fallback;
    return {
      parties: pick('parties', 'The parties are not stated in the current draft.'),
      purpose: pick('purpose', 'The purpose is not clearly stated in the current draft.'),
      payment: pick('payment', 'Payment terms are not stated in the current draft.'),
      timeline: pick('timeline', 'No dates are stated in the current draft.'),
      responsibilities: pick('responsibilities', 'Responsibilities are not detailed in the current draft.'),
      termination: pick('termination', 'The draft does not state how the agreement can be ended.'),
      importantDates: asArray(raw.importantDates)
        .filter((d) => isRecord(d) && typeof d.label === 'string' && typeof d.date === 'string')
        .slice(0, 8)
        .map((d) => ({ label: String(d.label).slice(0, 80), date: String(d.date).slice(0, 40) })),
    };
  }

  async questions(input: AiQuestionsInput): Promise<AiQuestionsOutput> {
    const raw = (await this.chat(
      SAFETY_PREAMBLE,
      `Task: suggest questions the drafter may want to answer IN the agreement, based on what is missing.
These are neutral drafting questions, not legal advice. Each question must be answerable with facts only the parties know.

Title: ${input.title}
Fields:
${input.fields.map((f) => `- ${f.label} (${f.code}): ${f.value || '(empty)'}`).join('\n')}
Sections:
${input.sections.filter((s) => s.included).map((s) => `## ${s.title}\n${s.body.slice(0, 400)}`).join('\n\n').slice(0, 5000)}

Respond with JSON:
{"questions":[{"text":"...","fieldCode":"related field code or null"}]}
Maximum 8 questions.`,
      600,
    )) as { questions?: unknown };
    return {
      questions: asArray(raw.questions)
        .filter((q) => isRecord(q) && typeof q.text === 'string')
        .slice(0, 10)
        .map((q) => ({
          text: String(q.text).slice(0, 300),
          fieldCode: typeof q.fieldCode === 'string' ? q.fieldCode : null,
        })),
    };
  }
}

/* ------------------------------ helpers ---------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Tolerate stray code fences even when the model was told not to add them. */
function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new AppError(502, 'AI_BAD_RESPONSE', 'The AI response could not be parsed. Try again.', { provider: 'openai' });
  }
}
