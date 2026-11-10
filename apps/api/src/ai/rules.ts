/**
 * RulesProvider, deterministic, offline implementation of the assistant.
 *
 * This is the DEFAULT provider: it needs no API key, no network, and never
 * hallucinates, it only re-structures what is actually present in the input
 * (description text, stored field values, section bodies). When it cannot
 * derive something it says so in `needsInput` instead of inventing it,
 * which is exactly the safety bar the product requires.
 *
 * The same five methods are implemented by LLM providers (see openai.ts);
 * the API layer and UI do not change when the provider does.
 */
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

export class RulesProvider implements AiProvider {
  readonly id = 'rules';
  readonly label = 'Rules assistant';

  async extract(input: AiExtractInput): Promise<AiExtractOutput> {
    return extractFromDescription(input);
  }

  async explain(input: AiExplainInput): Promise<AiExplainOutput> {
    return explainClause(input.text);
  }

  async review(input: AiReviewInput): Promise<AiReviewOutput> {
    return reviewDraft(input);
  }

  async summarize(input: AiSummaryInput): Promise<AiSummaryOutput> {
    return summarizeDraft(input);
  }

  async questions(input: AiQuestionsInput): Promise<AiQuestionsOutput> {
    return suggestQuestions(input);
  }
}

/* ------------------------- feature 1: extraction -------------------------- */

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  // Ghana cedi first (primary market). Keep "$" / "dollars" as USD.
  [/\bGH₵|GH¢|GHC\b|\bGHS\b|\bcedis?\b|\bpesewas?\b/i, 'GHS'],
  [/\bdollars?\b|\bUSD\b|\$/i, 'USD'],
  [/\beuros?\b|\bEUR\b|€/i, 'EUR'],
  [/\bpounds?\b|\bGBP\b|£/i, 'GBP'],
  [/\bnairas?\b|\bNGN\b|₦/i, 'NGN'],
  [/\brupees?\b|\bINR\b|₹/i, 'INR'],
  [/\brands?\b|\bZAR\b/i, 'ZAR'],
  [/\bshillings?\b|\bKES\b/i, 'KES'],
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

function wordToNumber(word: string): number | null {
  const asNumber = Number(word);
  if (!Number.isNaN(asNumber) && word.trim() !== '') return asNumber;
  return NUMBER_WORDS[word.toLowerCase()] ?? null;
}

/** "8,000" / "8000.50" → 8000 / 8000.5; keeps numbers out of percentages. */
function findAmount(text: string): { value: string; basis: string } | null {
  // Prefer an amount that sits next to a currency word/symbol.
  for (const [pattern, code] of CURRENCY_WORDS) {
    const symbolFirst = text.match(
      new RegExp(`(?:${source(pattern)})\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, 'i'),
    );
    if (symbolFirst?.[1]) {
      return { value: normalizeAmount(symbolFirst[1]), basis: `${symbolFirst[0]} (${code})` };
    }
    const wordAfter = text.match(
      new RegExp(`([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*(?:${source(pattern)})`, 'i'),
    );
    if (wordAfter?.[1]) {
      return { value: normalizeAmount(wordAfter[1]), basis: `${wordAfter[0]} (${code})` };
    }
  }
  // Fallback: amount after a money verb ("costs", "price", "fee", "total").
  const verb = text.match(
    /\b(?:costs?|price|fee|total|charge[sd]?|worth|pay(?:ing)?)\b[^0-9]{0,20}([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  );
  if (verb?.[1]) return { value: normalizeAmount(verb[1]), basis: verb[0] };
  return null;
}

function source(re: RegExp): string {
  return re.source.replace(/^\\b|\\b$/g, '');
}

function normalizeAmount(raw: string): string {
  return raw.replace(/,/g, '');
}

function findCurrency(text: string): { code: string; basis: string } | null {
  for (const [pattern, code] of CURRENCY_WORDS) {
    const m = text.match(pattern);
    if (m) return { code, basis: m[0] };
  }
  return null;
}

/** Payment schedule from phrasing; "50% … and 50% …" becomes Custom + text. */
function findPaymentSchedule(text: string): {
  schedule: string | null;
  custom: string | null;
  basis: string | null;
} {
  const percentMatches = [...text.matchAll(/(\d{1,3})\s*%/g)];
  if (percentMatches.length >= 2) {
    // Use the full sentences that carry the percentages (never mid-word cuts).
    const sentences = text.split(/(?<=[.!?])\s+/);
    const clauses = sentences.filter((s) => /\d{1,3}\s*%/.test(s)).map((s) => s.trim());
    return {
      schedule: 'Custom',
      custom: clauses.join(' ') || percentMatches.map((m) => m[0]).join(' + '),
      basis: percentMatches.map((m) => m[0]).join(' and '),
    };
  }
  if (/\bupfront\b|\bup[- ]front\b|\badvance\b|\bbefore\b[^.]{0,40}\b(start|development|work)\b/i.test(text)) {
    return { schedule: 'On signing', custom: null, basis: null };
  }
  if (/\bmonthly\b|\bevery month\b|\bper month\b/i.test(text)) {
    return { schedule: 'Monthly', custom: null, basis: null };
  }
  if (/\bon completion\b|\bon delivery\b|\bafter delivery\b|\bupon completion\b|\bwhen .{0,40}(launch|deliver|complete|finish)/i.test(text)) {
    return { schedule: 'On delivery', custom: null, basis: null };
  }
  if (/\bmilestone/i.test(text)) {
    return { schedule: 'Per milestone', custom: null, basis: null };
  }
  return { schedule: null, custom: null, basis: null };
}

function findRevisions(text: string): { value: string; basis: string } | null {
  const m = text.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b[^.]{0,30}\b(revisions?|rounds? of (?:revision|changes)|change rounds?)\b/i,
  );
  if (!m?.[1]) return null;
  const n = wordToNumber(m[1]);
  if (n === null) return null;
  return { value: String(n), basis: m[0] };
}

function findMaintenance(text: string): {
  yes: { value: string; basis: string } | null;
  terms: { value: string; basis: string } | null;
} {
  const m = text.match(
    /\b(\d+|one|two|three|six|twelve|a)?\s*(months?|weeks?|years?|days?)\s+of\s+(?:ongoing\s+)?(?:maintenance|support)\b/i,
  );
  const explicitNo = /\bno\s+(?:ongoing\s+)?(?:maintenance|support)\b|\bwithout\s+(?:maintenance|support)\b/i.test(text);
  const explicitYes = /\b(?:will|to be)?\s*provided\s+(?:ongoing\s+)?(?:maintenance|support)\b|\bmaintenance\b|\bsupport\b/i.test(
    text,
  );
  if (m?.[2]) {
    const n = m[1] ? wordToNumber(m[1]) : 1;
    const unit = m[2].toLowerCase();
    const duration = `${n ?? 1} ${unit}${(n ?? 1) === 1 ? '' : unit.endsWith('s') ? '' : 's'}`;
    return {
      yes: { value: 'Yes', basis: m[0] },
      terms: { value: `Maintenance and support for ${duration} after delivery.`, basis: m[0] },
    };
  }
  if (explicitNo) return { yes: { value: 'No', basis: 'no maintenance mentioned' }, terms: null };
  if (explicitYes) return { yes: { value: 'Yes', basis: 'maintenance mentioned' }, terms: null };
  return { yes: null, terms: null };
}

/** Client: "for X's Kitchen", "for Acme Corp", "client is Bob". */
function findClient(text: string): { value: string; basis: string } | null {
  const possessive = text.match(/\bfor\s+([A-Z][\w'’]*(?:\s+[A-Z&][\w'’]*)*(?:'s|’s)?\s*[A-Z]?[\w’']*)/);
  if (possessive?.[1]) {
    const cleaned = possessive[1].trim().replace(/\s+/g, ' ');
    if (cleaned.length >= 2) return { value: cleaned, basis: possessive[0] };
  }
  const labeled = text.match(/\b(?:client|customer)\s*(?:is|:)\s*([A-Z][\w'’]*(?:\s+[A-Z&][\w'’]*)*)/i);
  if (labeled?.[1]) return { value: labeled[1].trim(), basis: labeled[0] };
  return null;
}

/** Service/project: "building a restaurant website" → "restaurant website". */
function findService(text: string): { value: string; basis: string } | null {
  const m = text.match(
    /\b(?:build(?:ing)?|design(?:ing)?|develop(?:ing)?|creat(?:e|ing)|writ(?:e|ing)|photo(?:graphy|graphing)|cater(?:ing)?|clean(?:ing)?|consult(?:ing)?|translat(?:e|ing)|teach(?:ing)?|repair(?:ing)?)\s+(?:a|an|the)?\s*([^,.;]{3,80}?)(?=\s+(?:for|with|using|by)\s+[A-Z]|\s*[,.]|$)/i,
  );
  if (m?.[1]) {
    return { value: m[1].trim().replace(/\s+/g, ' '), basis: m[0] };
  }
  return null;
}

function findGenericSlot(fieldCode: string): string | null {
  const map: Record<string, string> = {
    client: 'Client',
    service: 'Service',
    project: 'Project',
    price: 'Price',
    amount: 'Price',
    currency: 'Currency',
    payment: 'Payment schedule',
    payment_schedule: 'Payment schedule',
    revisions: 'Revision limit',
    revision_limit: 'Revision limit',
    maintenance: 'Maintenance',
  };
  return map[fieldCode] ?? null;
}

export function extractFromDescription(input: AiExtractInput): AiExtractOutput {
  const text = input.description;
  const fields: AiExtractOutput['fields'] = [];
  const needsInput: string[] = [];
  const known = new Set(input.fields.map((f) => f.code));

  const client = findClient(text);
  const service = findService(text);
  const amount = findAmount(text);
  const currency = findCurrency(text);
  const schedule = findPaymentSchedule(text);
  const revisions = findRevisions(text);
  const maintenance = findMaintenance(text);

  const push = (
    code: string,
    label: string,
    value: string | null,
    confidence: 'high' | 'medium' | 'low',
    basis?: string,
    note?: string,
  ) => {
    if (value) fields.push({ fieldCode: code, label, value, confidence, basis });
    else if (note) needsInput.push(note);
  };

  // When a template is selected, map onto its real field codes (only codes
  // the template actually has); otherwise use generic slot names.
  const codeFor = (preferred: string[], generic: string): string | null => {
    if (input.fields.length === 0) return generic;
    for (const code of preferred) if (known.has(code)) return code;
    return null;
  };

  const clientCode = codeFor(
    ['client_name', 'client', 'customer_name', 'tenant_name', 'receiving_party', 'recipient_name'],
    'client',
  );
  const serviceCode = codeFor(
    ['service_description', 'service', 'services', 'project_scope', 'scope', 'property_description', 'purpose'],
    'service',
  );
  const feeCode = codeFor(['project_fee', 'fee', 'price', 'rent_amount', 'amount', 'total_fee'], 'price');
  const currencyCode = codeFor(['currency'], 'currency');
  const scheduleCode = codeFor(['payment_schedule', 'payment_terms', 'schedule'], 'payment_schedule');
  const customScheduleCode = codeFor(['custom_schedule', 'custom_payment_schedule'], 'custom_payment_schedule');
  const revisionsCode = codeFor(['revision_limit', 'revisions'], 'revision_limit');
  const maintenanceCode = codeFor(['maintenance', 'ongoing_maintenance'], 'maintenance');
  const maintenanceTermsCode = codeFor(['maintenance_terms', 'support_terms'], 'maintenance_terms');

  if (input.fields.length === 0) {
    // Generic slots, the brief's own vocabulary.
    push('client', 'Client', client?.value ?? null, client ? 'high' : 'medium', client?.basis,
      'Who is the client (the other party)?');
    push('service', 'Service', service?.value ?? null, service ? 'high' : 'medium', service?.basis,
      'What service or item is being provided?');
    push('price', 'Price', amount?.value ?? null, amount ? 'high' : 'medium', amount?.basis,
      'What is the total price?');
    push('currency', 'Currency', currency?.code ?? null, currency ? 'high' : 'medium', currency?.basis,
      'Which currency is the price in?');
    if (schedule.schedule) {
      push('payment_schedule', 'Payment schedule', schedule.schedule, 'medium', schedule.basis ?? undefined);
    } else {
      needsInput.push('How will payment be staged (upfront, milestones, on delivery)?');
    }
    if (revisions) push('revision_limit', 'Revision limit', revisions.value, 'high', revisions.basis);
    else needsInput.push('How many revisions are included?');
    if (maintenance.yes) {
      push('maintenance', 'Maintenance', maintenance.yes.value, 'medium', maintenance.yes.basis);
      if (maintenance.terms) {
        push('maintenance_terms', 'Maintenance terms', maintenance.terms.value, 'medium', maintenance.terms.basis);
      }
    } else {
      needsInput.push('Is ongoing maintenance or support included?');
    }
    return { fields, needsInput };
  }

  // Template-aware mapping.
  if (clientCode) push(clientCode, labelOf(input, clientCode), client?.value ?? null, client ? 'high' : 'medium', client?.basis,
    client ? undefined : 'Who is the client / other party?');
  if (serviceCode) {
    push(serviceCode, labelOf(input, serviceCode), service?.value ?? null, service ? 'high' : 'medium', service?.basis,
      service ? undefined : 'What is being provided (describe the work or item)?');
  }
  if (feeCode) push(feeCode, labelOf(input, feeCode), amount?.value ?? null, amount ? 'high' : 'medium', amount?.basis,
    amount ? undefined : 'What is the total price/fee?');
  if (currencyCode) {
    // Only suggest a currency the template actually offers, else ask.
    const spec = input.fields.find((f) => f.code === currencyCode);
    const options = spec?.options ?? [];
    if (currency && (options.length === 0 || options.includes(currency.code))) {
      push(currencyCode, spec?.label ?? 'Currency', currency.code, 'high', currency.basis);
    } else {
      needsInput.push(
        currency
          ? `Confirm the currency (detected ${currency.code}, choose from the template's list).`
          : 'Which currency is the price in?',
      );
    }
  }
  if (scheduleCode) {
    const spec = input.fields.find((f) => f.code === scheduleCode);
    const options = spec?.options ?? [];
    if (schedule.schedule && (options.length === 0 || options.includes(schedule.schedule))) {
      push(scheduleCode, spec?.label ?? 'Payment schedule', schedule.schedule, 'medium', schedule.basis ?? undefined);
      if (schedule.schedule === 'Custom' && customScheduleCode && schedule.custom) {
        push(customScheduleCode, labelOf(input, customScheduleCode), schedule.custom, 'medium', schedule.basis ?? undefined);
      }
    } else {
      needsInput.push('How will the payment be staged (signing/milestones/delivery)?');
    }
  } else if (schedule.schedule === 'Custom' && customScheduleCode && schedule.custom) {
    push(customScheduleCode, labelOf(input, customScheduleCode), schedule.custom, 'medium', schedule.basis ?? undefined);
  }
  if (revisionsCode) {
    push(revisionsCode, labelOf(input, revisionsCode), revisions?.value ?? null, revisions ? 'high' : 'medium', revisions?.basis,
      revisions ? undefined : 'How many revision rounds are included?');
  }
  if (maintenanceCode) {
    push(maintenanceCode, labelOf(input, maintenanceCode), maintenance.yes?.value ?? null, maintenance.yes ? 'medium' : 'low',
      maintenance.yes?.basis, maintenance.yes ? undefined : 'Is ongoing maintenance included?');
    if (maintenance.terms && maintenanceTermsCode) {
      push(maintenanceTermsCode, labelOf(input, maintenanceTermsCode), maintenance.terms.value, 'medium', maintenance.terms.basis);
    }
  }

  return { fields, needsInput };
}

function labelOf(input: AiExtractInput, code: string): string {
  return input.fields.find((f) => f.code === code)?.label ?? findGenericSlot(code) ?? code;
}

/* ------------------------- feature 3: explanation ------------------------- */

/**
 * Common formal phrases → plain language.
 * [pattern, short inline rewrite, detailed meaning for the phrase list].
 * The inline rewrite stays SHORT so re-read text flows; detail lives in
 * the phrases list the UI shows alongside.
 */
const PHRASE_BOOK: Array<[RegExp, string, string]> = [
  [/\bhereby\b/i, 'by this document', '“Hereby” just means “by this document”, it makes the sentence official as of signing.'],
  [/\bshall\b/i, 'must', '“Shall” states an obligation: the party named has to do it.'],
  [/\bterminate\b/i, 'end', 'To terminate is to end or cancel the agreement early.'],
  [/\btermination\b/i, 'ending the agreement', 'Termination is the process of ending the agreement, usually with notice.'],
  [/\bindemnif(?:y|ies|ication)\b/i, 'cover losses from', 'To indemnify is to cover the other party’s losses in the situations the clause describes, read exactly which situations.'],
  [/\bhold harmless\b/i, 'not blame for losses', '“Hold harmless” means not making the other party pay for certain losses.'],
  [/\bliability\b/i, 'legal responsibility', 'Liability is legal responsibility for loss or damage.'],
  [/\bconfidential(?:ity|information)\b/i, 'private information', 'Confidentiality covers what must stay private and for how long.'],
  [/\bintellectual property\b|\bIP\b/i, 'ownership of creations', 'Intellectual property covers who owns creations like designs, code, or text, and who may use them.'],
  [/\bgoverning law\b/i, 'applicable law', 'The governing law is which country’s or state’s laws interpret the agreement.'],
  [/\bjurisdiction\b/i, 'which courts', 'Jurisdiction is which courts may hear a dispute.'],
  [/\bseverab(?:le|ility)\b/i, 'partly separable', 'A severable agreement means if one part is found invalid, the rest still applies.'],
  [/\bforce majeure\b/i, 'events beyond control', 'Force majeure covers events outside anyone’s control (natural disasters, wars) that may excuse delays.'],
  [/\bnon-?disclosure\b/i, 'secrecy agreement', 'A non-disclosure agreement means both sides agree not to share certain information.'],
  [/\bbreach\b/i, 'break the agreement', 'A breach is failing to do something the agreement requires.'],
  [/\bconsideration\b/i, 'what each side gives', 'Consideration is what each side gives up (money, work, a promise), the “value” that makes the deal.'],
  [/\beffective date\b/i, 'start date', 'The effective date is when the agreement starts applying.'],
  [/\bwork product\b/i, 'the created deliverables', 'Work product means the deliverables and materials created for the project.'],
  [/\bnet\s?30\b/i, 'due in 30 days', '“Net 30” means payment is due within 30 days of an invoice.'],
  [/\blate fee\b|\blate charge\b/i, 'late fee', 'A late fee is an extra amount owed when payment is past its due date.'],
];

export function explainClause(text: string): AiExplainOutput {
  const phrases: AiExplainOutput['phrases'] = [];
  for (const [pattern, , detail] of PHRASE_BOOK) {
    const m = text.match(pattern);
    if (m) phrases.push({ formal: m[0], plain: detail });
  }

  // Single-pass alternation so overlapping terms ("shall indemnify") don't
  // stack two rewrites on top of each other.
  const alternation = new RegExp(
    PHRASE_BOOK.map(([pattern]) => `(${pattern.source})`).join('|'),
    'gi',
  );
  const replacementFor = new Map<string, string>(
    PHRASE_BOOK.map(([pattern, inline]) => [pattern.source.toLowerCase(), inline]),
  );
  const plain = text.replace(alternation, (match, ...groups) => {
    for (let i = 0; i < PHRASE_BOOK.length; i++) {
      if (groups[i] !== undefined) {
        return replacementFor.get(PHRASE_BOOK[i]![0].source.toLowerCase()) ?? match;
      }
    }
    return match;
  });

  // Trim to two sentences for readability.
  const sentences = plain.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
  const plainLanguage =
    sentences ||
    'This clause sets out terms the parties agreed to. Try selecting a longer piece of text for a clearer explanation.';

  return {
    plainLanguage: `In plain language: ${plainLanguage}`.slice(0, 600),
    phrases: phrases.slice(0, 8),
  };
}

/* --------------------- features 2/5: gaps & questions -------------------- */

/** Section code/title hints → the topics they carry (used for gap mapping). */
const TOPIC_HINTS: Array<{ re: RegExp; label: string; detail: string; fieldCode: string | null; severity: 'important' | 'worth-considering' }> = [
  {
    re: /\b(cancel|termination|terminate|end this agreement|notice period)\b/i,
    label: 'cancellation terms',
    detail: 'How either side can end the agreement, and any notice period or fees.',
    fieldCode: null,
    severity: 'important',
  },
  {
    re: /\b(dispute|mediat|arbitrat|governing law|jurisdiction|courts?)\b/i,
    label: 'dispute handling',
    detail: 'How disagreements would be resolved and which law applies.',
    fieldCode: null,
    severity: 'worth-considering',
  },
  {
    re: /\b(intellectual property|ownership|copyright|source code|royalty)\b/i,
    label: 'ownership of the work',
    detail: 'Who owns the finished work, and when ownership transfers.',
    fieldCode: null,
    severity: 'important',
  },
  {
    re: /\b(late|overdue|interest|penalty)\b/i,
    label: 'late payment terms',
    detail: 'What happens if payment arrives after the due date.',
    fieldCode: null,
    severity: 'worth-considering',
  },
  {
    re: /\b(confidential|non-?disclosure|private information)\b/i,
    label: 'confidentiality',
    detail: 'What must be kept private, and for how long.',
    fieldCode: null,
    severity: 'worth-considering',
  },
];

export function reviewDraft(input: AiReviewInput): AiReviewOutput {
  const items: AiReviewOutput['items'] = [];

  // 1) Required fields still blank, the strongest signal of missing info.
  for (const field of input.fields) {
    if (field.required && field.value.trim() === '') {
      items.push({
        fieldCode: field.code,
        label: field.label.toLowerCase(),
        detail: `The agreement does not yet state the ${field.label.toLowerCase()}.`,
        severity: 'important',
      });
    }
  }

  // 2) Topic coverage across included sections.
  const fullText = input.sections
    .filter((s) => s.included)
    .map((s) => `${s.title}\n${s.body}`)
    .join('\n');
  for (const topic of TOPIC_HINTS) {
    if (!topic.re.test(fullText)) {
      items.push({
        fieldCode: topic.fieldCode,
        label: topic.label,
        detail: topic.detail,
        severity: topic.severity,
      });
    }
  }

  // 3) No dates anywhere → flag timeline.
  const hasDate = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(fullText);
  if (!hasDate) {
    items.push({
      fieldCode: null,
      label: 'project completion date',
      detail: 'No start or completion date appears in the current draft.',
      severity: 'important',
    });
  }

  return { items: items.slice(0, 12) };
}

export function suggestQuestions(input: AiQuestionsInput): AiQuestionsOutput {
  const questions: AiQuestionsOutput['questions'] = [];
  const fullText = input.sections
    .filter((s) => s.included)
    .map((s) => `${s.title}\n${s.body}`)
    .join('\n');

  const blank = (codes: string[]): string | null =>
    codes.find((c) => {
      const f = input.fields.find((x) => x.code === c);
      return f && f.value.trim() === '';
    }) ?? null;

  const revCode = blank(['revision_limit', 'revisions']);
  if (revCode) questions.push({ text: 'How many revisions are included?', fieldCode: revCode });

  const ownerTopic = TOPIC_HINTS.find((t) => t.label === 'ownership of the work')!;
  if (!ownerTopic.re.test(fullText)) {
    questions.push({ text: 'Who owns the website source code after payment?', fieldCode: null });
  }
  const lateTopic = TOPIC_HINTS.find((t) => t.label === 'late payment terms')!;
  if (!lateTopic.re.test(fullText)) {
    questions.push({ text: 'What happens if payment is late?', fieldCode: null });
  }
  const cancelTopic = TOPIC_HINTS.find((t) => t.label === 'cancellation terms')!;
  if (!cancelTopic.re.test(fullText)) {
    questions.push({ text: 'How can either party cancel this agreement, and with what notice?', fieldCode: null });
  }
  const confTopic = TOPIC_HINTS.find((t) => t.label === 'confidentiality')!;
  if (!confTopic.re.test(fullText)) {
    questions.push({ text: 'Should either party keep certain information private?', fieldCode: null });
  }

  // Generic prompts tied to blank required fields.
  for (const field of input.fields) {
    if (field.required && field.value.trim() === '') {
      questions.push({
        text: `What should the agreement say about “${field.label}”?`,
        fieldCode: field.code,
      });
    }
  }

  // De-duplicate by text, cap the list.
  const seen = new Set<string>();
  const unique = questions.filter((q) => (seen.has(q.text) ? false : (seen.add(q.text), true)));
  return { questions: unique.slice(0, 10) };
}

/* --------------------------- feature 4: summary --------------------------- */

function valueOf(input: AiSummaryInput, codes: string[]): string | null {
  for (const code of codes) {
    const f = input.fields.find((x) => x.code === code);
    if (f && f.value.trim() !== '') return f.value.trim();
  }
  return null;
}

function sectionBody(input: AiSummaryInput, pattern: RegExp): string | null {
  const s = input.sections.find((x) => x.included && pattern.test(`${x.code} ${x.title}`));
  if (!s || s.body.trim() === '') return null;
  // First sentence only, summaries stay concise.
  return (s.body.split(/(?<=[.!?])\s+/)[0] ?? s.body).trim();
}

export function summarizeDraft(input: AiSummaryInput): AiSummaryOutput {
  const provider = valueOf(input, ['provider_name', 'service_provider', 'supplier_name', 'landlord_name', 'disclosing_party', 'creator_name']);
  const client = valueOf(input, ['client_name', 'customer_name', 'tenant_name', 'receiving_party']);

  const parties =
    provider && client
      ? `${provider} (provider) and ${client} (client).`
      : provider ?? client
        ? `One party: ${provider ?? client}. The other party is not stated yet.`
        : 'The parties are not stated in the current draft.';

  const service = valueOf(input, ['service_description', 'service', 'services', 'purpose', 'property_description', 'project_scope']);
  const purpose = service
    ? `This agreement covers: ${service}.`
    : sectionBody(input, /service|scope|purpose|summary/i)
      ?? 'The purpose is not clearly stated in the current draft.';

  const fee = valueOf(input, ['project_fee', 'fee', 'price', 'rent_amount', 'amount', 'total_fee']);
  const currency = valueOf(input, ['currency']);
  const schedule = valueOf(input, ['payment_schedule', 'payment_terms']);
  const customSchedule = valueOf(input, ['custom_schedule', 'custom_payment_schedule']);
  const paymentParts: string[] = [];
  if (fee) paymentParts.push(`${currency ? `${currency} ` : ''}${fee}`);
  if (schedule) paymentParts.push(schedule === 'Custom' && customSchedule ? customSchedule : `paid ${schedule.toLowerCase()}`);
  // Avoid "delivery.." when a part already ends with a period.
  const payment =
    paymentParts.length > 0
      ? `Total: ${paymentParts.join(', ').replace(/\.$/, '')}.`
      : 'Payment terms are not stated in the current draft.';

  const start = valueOf(input, ['start_date', 'commencement_date']);
  const delivery = valueOf(input, ['delivery_date', 'end_date', 'completion_date']);
  const timeline =
    start || delivery
      ? [start ? `starts ${start}` : null, delivery ? `targeted completion ${delivery}` : null].filter(Boolean).join(', ') + '.'
      : 'No dates are stated in the current draft.';

  const scope = valueOf(input, ['project_scope', 'scope', 'responsibilities', 'duties', 'tenant_responsibilities']);
  const responsibilities = scope
    ? scope
    : sectionBody(input, /scope|responsibilit|services/i)
      ?? 'Responsibilities are not detailed in the current draft.';

  const termination = sectionBody(input, /cancel|termination/i)
    ?? 'The draft does not state how the agreement can be ended.';

  const importantDates: AiSummaryOutput['importantDates'] = [];
  const expires = valueOf(input, ['expires_at', 'expiry_date']);
  if (start) importantDates.push({ label: 'Start date', date: start });
  if (delivery) importantDates.push({ label: 'Delivery / completion', date: delivery });
  if (expires) importantDates.push({ label: 'Expiry', date: expires });

  return { parties, purpose, payment, timeline, responsibilities, termination, importantDates };
}
