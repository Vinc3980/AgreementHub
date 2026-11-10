'use client';

/**
 * Agreement Assistant panel, the single AI surface used across the app.
 *
 * Modes:
 *  - `create`: describe → extract → per-suggestion Accept/Edit/Reject.
 *    Nothing is written here; accepted values are handed to the parent via
 *    `onAcceptedChange` and applied by the create flow with provenance
 *    `AI_SUGGESTED_CONFIRMED` (the user's explicit confirmation).
 *  - `edit`: same extraction flow, but Accept PATCHes the field directly
 *    with `AI_SUGGESTED_CONFIRMED` (user confirmation = the Accept click).
 *  - `view`: read-only features only (review / explain / summary /
 *    questions), safe on finalized agreements because they never write.
 *
 * Safety rules mirrored from the API (see apps/api/src/services/aiAssistant.ts):
 *  - every result carries the fixed disclaimer and an "AI suggestion" label;
 *  - review output is framed as "Potentially missing information";
 *  - the assistant never claims legality, enforceability, or validity;
 *  - it never inserts anything without an explicit user action.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  Check,
  HelpCircle,
  ListChecks,
  Pencil,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusGlyph } from '@/components/ui/status-stamp';
import { Input, Select, Textarea } from '@/components/ui/field';
import { ApiError, patch, post } from '@/lib/api';
import { useToast } from '@/lib/toast';
import type {
  AiExtractResponse,
  AiExplainResponse,
  AiQuestionsResponse,
  AiReviewResponse,
  AiSummaryResponse,
} from '@/lib/types';

type Mode = 'create' | 'edit' | 'view';

export interface AcceptedField {
  code: string;
  label: string;
  value: string;
}

type Decision = 'accepted' | 'rejected';

type ResultKind = 'review' | 'summary' | 'questions' | 'explain';

type Result =
  | { kind: 'review'; data: AiReviewResponse }
  | { kind: 'summary'; data: AiSummaryResponse }
  | { kind: 'questions'; data: AiQuestionsResponse }
  | { kind: 'explain'; data: AiExplainResponse };

const FALLBACK_DISCLAIMER = 'AI-generated assistance. Review carefully. This is not legal advice.';

const CONFIDENCE_TONE = {
  high: 'success',
  medium: 'info',
  low: 'neutral',
} as const;

export function AssistantPanel({
  mode,
  agreementId,
  templateId,
  sections = [],
  onAcceptedChange,
  onFocusField,
}: {
  mode: Mode;
  /** Present in edit/view modes, the panel's read/write target. */
  agreementId?: string;
  /** Template suggestions map onto (create/edit modes). */
  templateId?: string | null;
  /** Stored sections, for explain-by-section pickers (edit/view modes). */
  sections?: Array<{ code: string; title: string }>;
  /** create mode: keeps the parent's copy of accepted suggestions current. */
  onAcceptedChange?: (fields: AcceptedField[]) => void;
  /** edit mode: jump the editor to the field a suggestion/question targets. */
  onFocusField?: (code: string) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  /* --------------------------- feature 1: extract ---------------------- */
  const canExtract = mode !== 'view';
  const [description, setDescription] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extract, setExtract] = useState<AiExtractResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [accepted, setAccepted] = useState<AcceptedField[]>([]);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [acceptingCode, setAcceptingCode] = useState<string | null>(null);

  // Changing template invalidates suggestions mapped to the old one.
  useEffect(() => {
    setExtract(null);
    setDecisions({});
    setAccepted([]);
    setEditingCode(null);
    onAcceptedChange?.([]);
    // onAcceptedChange is a caller convenience; re-running on it could loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  function reportAccepted(next: AcceptedField[]) {
    setAccepted(next);
    onAcceptedChange?.(next);
  }

  async function runExtract() {
    if (!description.trim()) return;
    setExtracting(true);
    try {
      const res = await post<AiExtractResponse>('/ai/extract', {
        description: description.trim(),
        ...(templateId ? { templateId } : {}),
      });
      setExtract(res);
      setDecisions({});
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not extract fields.');
    } finally {
      setExtracting(false);
    }
  }

  async function acceptField(field: AiExtractResponse['fields'][number], value: string) {
    if (mode === 'edit' && agreementId) {
      setAcceptingCode(field.fieldCode);
      try {
        await patch(`/agreements/${agreementId}`, {
          fields: [
            { code: field.fieldCode, value, provenance: 'AI_SUGGESTED_CONFIRMED' },
          ],
        });
        await queryClient.invalidateQueries({ queryKey: ['agreement', agreementId] });
        setDecisions((prev) => ({ ...prev, [field.fieldCode]: 'accepted' }));
        setEditingCode(null);
        toast.success(`“${field.label}” applied to the draft and marked AI-confirmed.`);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not apply the suggestion.');
      } finally {
        setAcceptingCode(null);
      }
      return;
    }
    // create mode: hold the confirmed value; the create flow applies it.
    setDecisions((prev) => ({ ...prev, [field.fieldCode]: 'accepted' }));
    setEditingCode(null);
    reportAccepted([
      ...accepted.filter((f) => f.code !== field.fieldCode),
      { code: field.fieldCode, label: field.label, value },
    ]);
  }

  function rejectField(field: AiExtractResponse['fields'][number]) {
    setDecisions((prev) => ({ ...prev, [field.fieldCode]: 'rejected' }));
    setEditingCode(null);
    reportAccepted(accepted.filter((f) => f.code !== field.fieldCode));
  }

  function undoDecision(field: AiExtractResponse['fields'][number]) {
    setDecisions((prev) => {
      const next = { ...prev };
      delete next[field.fieldCode];
      return next;
    });
    reportAccepted(accepted.filter((f) => f.code !== field.fieldCode));
  }

  /* --------------------- features 2-5: read-only ----------------------- */
  const [result, setResult] = useState<Result | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ResultKind | null>(null);

  // Explain inputs: pick a stored section, or paste custom text.
  const [explainTarget, setExplainTarget] = useState<string>(sections[0]?.code ?? 'custom');
  const [explainText, setExplainText] = useState('');

  async function runAction(kind: ResultKind) {
    if (!agreementId) return;
    setPendingAction(kind);
    setActionError(null);
    try {
      if (kind === 'review') {
        const data = await post<AiReviewResponse>(`/agreements/${agreementId}/ai/review`, {});
        setResult({ kind, data });
      } else if (kind === 'summary') {
        const data = await post<AiSummaryResponse>(`/agreements/${agreementId}/ai/summary`, {});
        setResult({ kind, data });
      } else if (kind === 'questions') {
        const data = await post<AiQuestionsResponse>(`/agreements/${agreementId}/ai/questions`, {});
        setResult({ kind, data });
      } else {
        const body =
          explainTarget === 'custom'
            ? { agreementId, text: explainText.trim() }
            : { agreementId, sectionCode: explainTarget };
        const data = await post<AiExplainResponse>(`/agreements/${agreementId}/ai/explain`, body);
        setResult({ kind, data });
      }
    } catch (err) {
      setResult(null);
      setActionError(err instanceof ApiError ? err.message : 'The assistant could not answer that.');
    } finally {
      setPendingAction(null);
    }
  }

  const disclaimer = result?.data.disclaimer ?? FALLBACK_DISCLAIMER;
  const providerLabel = result?.data.providerLabel ?? null;
  const busy = extracting || pendingAction !== null;

  return (
    <section
      className="border-y border-rule bg-sheet px-5 py-5"
      aria-label="Agreement Assistant"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-rule pb-3">
        <div className="flex items-start gap-3">
          <StatusGlyph name="review" className="mt-1 h-4 w-4 shrink-0 text-attention" />
          <div>
            <p className="text-caps text-attention">Suggestion slip · AI-assisted</p>
            <h2 className="mt-0.5 font-serif text-lg text-ink">Agreement assistant</h2>
          </div>
        </div>
        <span className="border border-attention-rule bg-attention-tint px-2 py-0.5 text-caps text-attention">
          Not legal advice
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-2">
        {mode === 'view'
          ? 'Review, explain, summarize, or ask questions about this agreement. Nothing here changes the agreement.'
          : 'Describe your agreement in plain language to get field suggestions, or ask the assistant to review, explain, summarize, or suggest questions.'}
      </p>

      {/* ---------------- feature 1: describe → extract → confirm -------- */}
      {canExtract ? (
        <div className="mt-4 border-t border-rule pt-4">
          <h3 className="text-sm font-semibold text-ink">Describe your agreement</h3>
          <Textarea
            className="mt-2"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. I am building a restaurant website for Kojo’s Kitchen. The project costs 8,000 cedis. They will pay 50% before development and 50% when the website is launched. Three revisions and two months of maintenance included."
            aria-label="Describe your agreement"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              loading={extracting}
              disabled={!description.trim() || (mode === 'create' && !templateId)}
              onClick={() => void runExtract()}
            >
              Generate fields
            </Button>
            {mode === 'create' && !templateId ? (
              <span className="text-xs text-ink-2">
                Select a template first. Suggestions map onto its fields.
              </span>
            ) : null}
          </div>

          {extract ? (
            <div className="mt-4 border-y border-rule bg-paper/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-ink">Suggested fields</h4>
                <Badge tone="brand">AI suggestion</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-2">
                {mode === 'edit'
                  ? 'Nothing is written until you press Accept. Each acceptance is recorded as AI-suggested and user-confirmed.'
                  : 'Nothing is added to your agreement until you accept a suggestion. The values are applied when you create the agreement.'}
              </p>

              {extract.fields.length === 0 ? (
                <p className="mt-3 text-sm text-ink-2">
                  Nothing confident enough to suggest from this description. Add details like
                  parties, price, dates, or payment terms and try again.
                </p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {extract.fields.map((field) => {
                    const decision = decisions[field.fieldCode];
                    const editing = editingCode === field.fieldCode;
                    return (
                      <li
                        key={field.fieldCode}
                        className="border-l-2 border-attention bg-paper/60 px-3 py-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-ink">{field.label}</span>
                            <span className="font-mono text-xs text-ink-3">{field.fieldCode}</span>
                            <Badge tone={CONFIDENCE_TONE[field.confidence]}>
                              {field.confidence} confidence
                            </Badge>
                            {decision === 'accepted' ? (
                              <Badge tone="success">
                                <Check className="h-3 w-3" aria-hidden />
                                {mode === 'edit' ? 'Applied' : 'Accepted'}
                              </Badge>
                            ) : null}
                            {decision === 'rejected' ? (
                              <Badge tone="neutral">
                                <X className="h-3 w-3" aria-hidden />
                                Rejected
                              </Badge>
                            ) : null}
                          </div>
                        </div>

                        {editing ? (
                          <div className="mt-2 flex flex-wrap items-end gap-2">
                            <Input
                              className="max-w-lg flex-1"
                              label="Value"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              autoFocus
                            />
                            <Button
                              size="sm"
                              loading={acceptingCode === field.fieldCode}
                              onClick={() => void acceptField(field, editValue)}
                            >
                              Save &amp; accept
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingCode(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <p className="mt-1.5 break-words text-sm text-ink">{field.value}</p>
                        )}

                        {field.basis ? (
                          <p className="mt-1 text-xs text-ink-3">
                            Based on: “{field.basis}”
                          </p>
                        ) : null}

                        {!editing && decision !== 'accepted' ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              loading={acceptingCode === field.fieldCode}
                              onClick={() => void acceptField(field, field.value)}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Pencil className="h-3.5 w-3.5" />}
                              onClick={() => {
                                setEditingCode(field.fieldCode);
                                setEditValue(field.value);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => rejectField(field)}
                            >
                              Reject
                            </Button>
                          </div>
                        ) : null}

                        {decision === 'accepted' ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Pencil className="h-3.5 w-3.5" />}
                              onClick={() => {
                                setEditingCode(field.fieldCode);
                                setEditValue(
                                  accepted.find((f) => f.code === field.fieldCode)?.value ??
                                    field.value,
                                );
                              }}
                            >
                              Change value
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => undoDecision(field)}>
                              Undo
                            </Button>
                          </div>
                        ) : null}
                        {decision === 'rejected' ? (
                          <div className="mt-2">
                            <Button size="sm" variant="ghost" onClick={() => undoDecision(field)}>
                              Undo reject
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              {extract.needsInput.length > 0 ? (
                <div className="mt-3 border-l-2 border-attention bg-attention-tint px-3 py-2.5">
                  <p className="text-sm font-medium text-ink">
                    The assistant could not determine these. Fill them in yourself:
                  </p>
                  <ul className="mt-1 list-inside list-disc text-sm text-ink-2">
                    {extract.needsInput.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------- features 2-5: review/explain/summary/questions ----- */}
      {agreementId ? (
        <div className="mt-4 border-t border-rule pt-4">
          <h3 className="text-sm font-semibold text-ink">Ask about this agreement</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={pendingAction === 'review'}
              disabled={busy}
              icon={<AlertTriangle className="h-4 w-4" />}
              onClick={() => void runAction('review')}
            >
              Review agreement
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={pendingAction === 'summary'}
              disabled={busy}
              icon={<BookOpen className="h-4 w-4" />}
              onClick={() => void runAction('summary')}
            >
              Summarize agreement
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={pendingAction === 'questions'}
              disabled={busy}
              icon={<HelpCircle className="h-4 w-4" />}
              onClick={() => void runAction('questions')}
            >
              Suggest questions
            </Button>
          </div>

          {/* Explain clause: stored section or custom text */}
          <div className="mt-3 border-y border-rule bg-paper/60 p-3">
            <label
              htmlFor="assistant-explain-target"
              className="text-sm font-medium text-ink"
            >
              Explain clause
            </label>
            <Select
              id="assistant-explain-target"
              className="mt-1.5"
              value={explainTarget}
              onChange={(e) => setExplainTarget(e.target.value)}
            >
              {sections.map((s) => (
                <option key={s.code} value={s.code}>
                  Section: {s.title}
                </option>
              ))}
              <option value="custom">Paste custom text…</option>
            </Select>
            {explainTarget === 'custom' ? (
              <Textarea
                className="mt-2"
                rows={3}
                value={explainText}
                onChange={(e) => setExplainText(e.target.value)}
                placeholder="Paste a clause you want explained in plain language."
                aria-label="Clause text to explain"
              />
            ) : null}
            <div className="mt-2">
              <Button
                size="sm"
                loading={pendingAction === 'explain'}
                disabled={busy || (explainTarget === 'custom' && !explainText.trim())}
                onClick={() => void runAction('explain')}
              >
                What does this mean?
              </Button>
            </div>
          </div>

          {actionError ? (
            <div
              className="mt-3 border-l-2 border-danger bg-danger-tint px-3 py-2.5 text-sm text-danger"
              role="alert"
            >
              {actionError}
            </div>
          ) : null}

          {/* Results */}
          {result ? (
            <div className="mt-4 border-y border-rule bg-paper/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-ink">
                  {result.kind === 'review'
                    ? result.data.heading
                    : result.kind === 'summary'
                      ? 'Agreement summary'
                      : result.kind === 'questions'
                        ? 'Suggested questions'
                        : 'Plain-language explanation'}
                </h4>
                <Badge tone="brand">AI suggestion</Badge>
              </div>

              {result.kind === 'review' ? (
                result.data.items.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-2">
                    Nothing stood out as potentially missing from the current draft.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2.5">
                    {result.data.items.map((item, i) => (
                      <li
                        key={`${item.label}-${i}`}
                        className="border-l-2 border-attention bg-paper/60 px-3 py-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            tone={item.severity === 'important' ? 'warning' : 'neutral'}
                          >
                            {item.severity === 'important'
                              ? 'Important to consider'
                              : 'Worth considering'}
                          </Badge>
                          <span className="text-sm font-medium text-ink">{item.label}</span>
                        </div>
                        <p className="mt-1 text-sm text-ink-2">{item.detail}</p>
                        {item.fieldCode && onFocusField ? (
                          <button
                            type="button"
                            className="mt-1.5 text-xs font-medium text-navy hover:underline"
                            onClick={() => onFocusField(item.fieldCode!)}
                          >
                            Open this field in the form →
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {result.kind === 'summary' ? (
                <dl className="mt-3 space-y-2.5">
                  {(
                    [
                      ['Parties', result.data.parties],
                      ['Purpose', result.data.purpose],
                      ['Payment', result.data.payment],
                      ['Timeline', result.data.timeline],
                      ['Responsibilities', result.data.responsibilities],
                      ['Termination', result.data.termination],
                    ] as Array<[string, string]>
                  ).map(([label, value]) => (
                    <div key={label} className="border-l-2 border-attention bg-paper/60 px-3 py-2.5">
                      <dt className="text-caps text-ink-3">
                        {label}
                      </dt>
                      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
                    </div>
                  ))}
                  {result.data.importantDates.length > 0 ? (
                    <div className="border-l-2 border-attention bg-paper/60 px-3 py-2.5">
                      <dt className="text-caps text-ink-3">
                        Important dates
                      </dt>
                      <dd className="mt-1 flex flex-wrap gap-2">
                        {result.data.importantDates.map((d) => (
                          <Badge key={`${d.label}-${d.date}`} tone="info">
                            {d.label}: {d.date}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              {result.kind === 'questions' ? (
                result.data.questions.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-2">
                    No suggested questions. The draft already covers the usual topics.
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-ink-2">
                      Drafting questions only. The assistant never adds them for you. Pick the
                      ones worth answering and fill them in yourself.
                    </p>
                    <ul className="mt-2 space-y-2">
                      {result.data.questions.map((q, i) => (
                        <li
                          key={`${q.text}-${i}`}
                          className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-attention bg-paper/60 px-3 py-2.5"
                        >
                          <span className="text-sm text-ink">{q.text}</span>
                          {q.fieldCode && onFocusField ? (
                            <button
                              type="button"
                              className="text-xs font-medium text-navy hover:underline"
                              onClick={() => onFocusField(q.fieldCode!)}
                            >
                              Open field →
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              ) : null}

              {result.kind === 'explain' ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="border-l-2 border-attention bg-paper/60 px-3 py-2.5">
                    <p className="text-caps text-ink-3">
                      Legal / formal text
                    </p>
                    <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink">
                      {result.data.formalText}
                    </p>
                  </div>
                  <div className="border-l-2 border-navy bg-navy-tint p-3">
                    <p className="text-xs font-semibold tracking-wider text-navy uppercase">
                      Plain language
                    </p>
                    <p className="mt-1.5 text-sm text-ink">{result.data.plainLanguage}</p>
                  </div>
                  {result.data.phrases.length > 0 ? (
                    <div className="sm:col-span-2">
                      <p className="text-caps text-ink-3">
                        Phrase by phrase
                      </p>
                      <ul className="mt-1.5 space-y-1.5">
                        {result.data.phrases.map((p) => (
                          <li
                            key={p.formal}
                            className="flex flex-wrap gap-1.5 border-b border-rule px-3 py-2 text-sm"
                          >
                            <span className="font-mono text-ink">{p.formal}</span>
                            <span className="text-ink-3" aria-hidden>
                              →
                            </span>
                            <span className="text-ink-2">{p.plain}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p className="sm:col-span-2 inline-flex items-center gap-1.5 text-xs text-ink-2">
                    <ListChecks className="h-3.5 w-3.5" aria-hidden />
                    Describes what the clause says; it is not legal advice or a validity claim.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Fixed disclaimer footer. Always visible in every mode. */}
      <p className="mt-4 border-t border-rule pt-3 text-xs text-ink-3">
        {disclaimer}
        {providerLabel ? <> · Engine: {providerLabel}</> : null}
      </p>
    </section>
  );
}
