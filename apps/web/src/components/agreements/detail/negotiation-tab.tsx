'use client';

/**
 * Negotiation tab, the human side of a versioned negotiation:
 *
 *  1. Section comments: author + timestamp + section + content + status
 *     (OPEN / RESOLVED), with resolve/reopen by the author or a manager.
 *  2. Change suggestions: suggest → accept / reject.
 *
 * Hard invariant: nothing on this tab changes contractual terms by itself.
 * Comments are records only, and a pending suggestion is inert, the document
 * changes only when someone with edit rights explicitly accepts (which runs
 * through the normal draft-update path and, during negotiation, freezes the
 * previous version).
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, MessageSquare, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { CardSkeleton, EmptyState, ErrorState, LoadingStatus, staggerStyle } from '@/components/ui/states';
import { WordDiff } from '@/components/agreements/detail/word-diff';
import { ApiError, patch, post } from '@/lib/api';
import { formatDateTime, titleCase, type Tone } from '@/lib/format';
import { useComments, useProposals } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useSession } from '@/lib/session';
import { useToast } from '@/lib/toast';
import type {
  AgreementDetailResponse,
  AgreementStatus,
  CommentItem,
  CommentStatus,
  ProposalKind,
} from '@/lib/types';
import type { TemplateDefinition } from '@agreementhub/domain/template';

/** Statuses where the deal is closed for both commenting and suggesting. */
const CLOSED_STATUSES: AgreementStatus[] = ['CANCELLED', 'TERMINATED', 'REJECTED', 'EXPIRED'];
/** Statuses in which the backend still accepts new suggestions. */
const SUGGESTABLE: AgreementStatus[] = ['DRAFT', 'REVIEW', 'NEGOTIATION'];

const KIND_LABELS: Record<ProposalKind, string> = {
  TITLE: 'Title',
  SECTION: 'Section',
  FIELD: 'Field',
};

const PROPOSAL_TONES: Record<string, Tone> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'neutral',
};

function humanize(code: string): string {
  return titleCase(code.replace(/[_-]+/g, ' '));
}

/** Extract the comparable text of a suggestion value. */
function displayValue(kind: ProposalKind, value: unknown): string {
  if (kind === 'SECTION') {
    const body = (value as { body?: unknown } | null)?.body;
    return typeof body === 'string' ? body : '';
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function NegotiationTab({
  detail,
  editable,
  manageable,
  templateDefinition,
}: {
  detail: AgreementDetailResponse;
  /** I may accept suggestions / edit the working copy. */
  editable: boolean;
  /** I may manage the agreement (e.g. change any comment's status). */
  manageable: boolean;
  templateDefinition: TemplateDefinition | null;
}) {
  const agreementId = detail.agreement.id;
  const status = detail.agreement.status;
  const closed = CLOSED_STATUSES.includes(status);
  const suggestable = SUGGESTABLE.includes(status) && !closed;

  const fieldLabel = useMemo(() => {
    const labels = new Map(templateDefinition?.fields.map((f) => [f.code, f.label]) ?? []);
    return (code: string) => labels.get(code) ?? humanize(code);
  }, [templateDefinition]);

  const sectionTitle = useMemo(() => {
    const titles = new Map(detail.sections.map((s) => [s.code, s.title]));
    return (code: string | null) => (code ? (titles.get(code) ?? humanize(code)) : null);
  }, [detail.sections]);

  const targetLabel = (kind: ProposalKind, code: string): string => {
    if (kind === 'TITLE') return 'Agreement title';
    if (kind === 'SECTION') return sectionTitle(code) ?? code;
    return fieldLabel(code);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-panel border border-rule-strong bg-navy-tint px-4 py-3.5">
        <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-navy" aria-hidden />
        <p className="text-sm text-ink">
          Comments and suggestions <b>never change the contract by themselves</b>. Terms change only
          when someone with edit rights accepts a suggestion (which freezes the previous version) or
          edits the draft directly.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <CommentsCard
          agreementId={agreementId}
          status={status}
          sections={detail.sections}
          sectionTitle={sectionTitle}
          canComment={!closed}
          manageable={manageable}
        />
        <SuggestionsCard
          detail={detail}
          status={status}
          editable={editable}
          suggestable={suggestable}
          targetLabel={targetLabel}
          templateDefinition={templateDefinition}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

function CommentsCard({
  agreementId,
  status,
  sections,
  sectionTitle,
  canComment,
  manageable,
}: {
  agreementId: string;
  status: AgreementStatus;
  sections: AgreementDetailResponse['sections'];
  sectionTitle: (code: string | null) => string | null;
  canComment: boolean;
  manageable: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const commentsQuery = useComments(agreementId);
  const showCommentsPending = useDelayedPending(commentsQuery.isPending && !commentsQuery.data);

  const [sectionCode, setSectionCode] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'comments'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'audit'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      post<{ comment: CommentItem }>('/comments', {
        agreementId,
        sectionCode: sectionCode || undefined,
        body: body.trim(),
      }),
    onSuccess: () => {
      toast.success('Comment added.');
      setBody('');
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not add the comment.'),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: CommentStatus }) =>
      patch<{ comment: CommentItem }>(`/comments/${id}`, { status: next }),
    onSuccess: (data) => {
      toast.success(
        data.comment.status === 'RESOLVED' ? 'Comment marked as resolved.' : 'Comment reopened.',
      );
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not update the comment status.'),
  });

  function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    createMutation.mutate();
  }

  const comments = commentsQuery.data?.comments ?? [];
  const openCount = comments.filter((c) => c.status === 'OPEN').length;

  return (
    <section className="border-y border-rule bg-sheet">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
            <MessageSquare className="h-4 w-4 text-navy" aria-hidden />
            Section comments
          </h3>
          <p className="mt-0.5 text-sm text-ink-2">
            Discuss the document without changing it. {openCount} of {comments.length} open.
          </p>
        </div>
        <Badge tone={openCount > 0 ? 'warning' : 'success'}>
          {openCount > 0 ? `${openCount} open` : 'All resolved'}
        </Badge>
      </div>

      {/* Add comment */}
      {canComment ? (
        <form onSubmit={onCreate} className="space-y-3 border-b border-rule px-5 py-4" noValidate>
          <Select
            label="Attach to"
            value={sectionCode}
            onChange={(e) => setSectionCode(e.target.value)}
            hint="Pick a section, or comment on the whole document."
          >
            <option value="">Whole document</option>
            {sections.map((s) => (
              <option key={s.code} value={s.code}>
                {s.title}
              </option>
            ))}
          </Select>
          <Textarea
            label="Comment"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="e.g. Payment terms should allow 30 days, not 14."
            rows={3}
            error={error}
            hint="Recorded with your name and a timestamp; it does not edit the document."
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              loading={createMutation.isPending}
              loadingLabel="Adding…"
              disabled={body.trim().length === 0}
            >
              Add comment
            </Button>
          </div>
        </form>
      ) : (
        <p className="border-b border-rule px-5 py-3.5 text-sm text-ink-2">
          Commenting is closed. This agreement is {status.toLowerCase()}.
        </p>
      )}

      {/* List */}
      {commentsQuery.isPending ? (
        showCommentsPending ? (
          <div className="px-5 py-4">
            <CardSkeleton rows={3} />
          </div>
        ) : (
          <div className="min-h-[8rem] px-5 py-4" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : commentsQuery.isError ? (
        <div className="px-5 py-4">
          <ErrorState onRetry={() => commentsQuery.refetch()} />
        </div>
      ) : comments.length === 0 ? (
        <div className="px-5 py-8">
          <EmptyState
            title="No comments yet"
            description="Start the discussion. Comments are visible to every authorized party."
          />
        </div>
      ) : (
        <ol className="max-h-[32rem] divide-y divide-rule overflow-y-auto content-fade-in">
          {comments.map((comment, i) => {
            const mine = user?.email.toLowerCase() === comment.authorLabel.toLowerCase();
            const canToggle = mine || manageable;
            const title = sectionTitle(comment.sectionCode);
            return (
              <li key={comment.id} className="stagger-item px-5 py-4" style={staggerStyle(i)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{comment.authorLabel}</span>
                    <Badge tone="neutral">{humanize(comment.authorType)}</Badge>
                    {title ? <Badge tone="info">{title}</Badge> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={comment.status === 'OPEN' ? 'warning' : 'success'}>
                      {comment.status === 'OPEN' ? 'Open' : 'Resolved'}
                    </Badge>
                    <span className="text-xs text-ink-2">{formatDateTime(comment.createdAt)}</span>
                  </div>
                </div>

                <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{comment.body}</p>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {canToggle ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={statusMutation.isPending && statusMutation.variables?.id === comment.id}
                      loadingLabel={comment.status === 'OPEN' ? 'Resolving…' : 'Reopening…'}
                      onClick={() =>
                        statusMutation.mutate({
                          id: comment.id,
                          next: comment.status === 'OPEN' ? 'RESOLVED' : 'OPEN',
                        })
                      }
                    >
                      {comment.status === 'OPEN' ? 'Mark resolved' : 'Reopen'}
                    </Button>
                  ) : null}
                  {comment.resolvedAt ? (
                    <span className="text-xs text-ink-2">
                      Resolved {formatDateTime(comment.resolvedAt)}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Suggestions                                                         */
/* ------------------------------------------------------------------ */

type FieldWidget = 'text' | 'textarea' | 'number' | 'toggle' | 'select';

function SuggestionsCard({
  detail,
  status,
  editable,
  suggestable,
  targetLabel,
  templateDefinition,
}: {
  detail: AgreementDetailResponse;
  status: AgreementStatus;
  editable: boolean;
  suggestable: boolean;
  targetLabel: (kind: ProposalKind, code: string) => string;
  templateDefinition: TemplateDefinition | null;
}) {
  const agreementId = detail.agreement.id;
  const toast = useToast();
  const queryClient = useQueryClient();
  const proposalsQuery = useProposals(agreementId);
  const showProposalsPending = useDelayedPending(proposalsQuery.isPending && !proposalsQuery.data);

  const [confirming, setConfirming] = useState<string | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'proposals'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'versions'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'audit'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }

  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'ACCEPTED' | 'REJECTED' }) =>
      post<{ versionCreated: { versionNumber: number } | null }>(
        `/proposals/${id}/decide`,
        { decision },
      ),
    onSuccess: (data, vars) => {
      if (vars.decision === 'ACCEPTED') {
        toast.success(
          data.versionCreated
            ? `Suggestion accepted. Applied as version ${data.versionCreated.versionNumber}.`
            : 'Suggestion accepted. The document was updated.',
        );
      } else {
        toast.success('Suggestion rejected. The document is unchanged.');
      }
      setConfirming(null);
      invalidate();
    },
    onError: (err) => {
      setConfirming(null);
      toast.error(err instanceof Error ? err.message : 'Could not record the decision.');
    },
  });

  const proposals = proposalsQuery.data?.proposals ?? [];
  const pending = proposals.filter((p) => p.status === 'PENDING').length;

  return (
    <section className="border-y border-rule bg-sheet">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
            <Lightbulb className="h-4 w-4 text-navy" aria-hidden />
            Change suggestions
          </h3>
          <p className="mt-0.5 text-sm text-ink-2">
            Propose a different term, then accept or reject it explicitly.
          </p>
        </div>
        <Badge tone={pending > 0 ? 'warning' : 'success'}>
          {pending > 0 ? `${pending} pending` : 'No pending'}
        </Badge>
      </div>

      {suggestable ? (
        <SuggestionForm
          detail={detail}
          templateDefinition={templateDefinition}
          targetLabel={targetLabel}
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'proposals'] });
            void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId, 'audit'] });
            void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
          }}
        />
      ) : (
        <p className="border-b border-rule px-5 py-3.5 text-sm text-ink-2">
          Suggestions are closed while the agreement is {status.toLowerCase()}.
        </p>
      )}

      {proposalsQuery.isPending ? (
        showProposalsPending ? (
          <div className="px-5 py-4">
            <CardSkeleton rows={3} />
          </div>
        ) : (
          <div className="min-h-[8rem] px-5 py-4" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : proposalsQuery.isError ? (
        <div className="px-5 py-4">
          <ErrorState onRetry={() => proposalsQuery.refetch()} />
        </div>
      ) : proposals.length === 0 ? (
        <div className="px-5 py-8">
          <EmptyState
            title="No suggestions yet"
            description="Raise one from the form above. It stays pending until someone accepts it."
          />
        </div>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-rule overflow-y-auto content-fade-in">
          {proposals.map((proposal, i) => {
            const currentText = displayValue(proposal.kind, proposal.currentValue);
            const proposedText = displayValue(proposal.kind, proposal.proposedValue);
            const isConfirming = confirming === proposal.id;
            return (
              <li key={proposal.id} className="stagger-item px-5 py-4" style={staggerStyle(i)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brand">{KIND_LABELS[proposal.kind]}</Badge>
                    <span className="text-sm font-medium text-ink">
                      {targetLabel(proposal.kind, proposal.targetCode)}
                    </span>
                  </div>
                  <Badge tone={PROPOSAL_TONES[proposal.status] ?? 'neutral'}>
                    {titleCase(proposal.status)}
                  </Badge>
                </div>

                <div className="mt-2">
                  <WordDiff from={currentText} to={proposedText} />
                </div>

                {proposal.note ? (
                  <p className="mt-2 rounded-control bg-vellum px-3 py-2 text-sm text-ink-2">
                    {proposal.note}
                  </p>
                ) : null}

                <p className="mt-2 text-xs text-ink-2">
                  Suggested by {proposal.proposedByLabel} · {formatDateTime(proposal.createdAt)}
                </p>
                {proposal.status !== 'PENDING' ? (
                  <p className="mt-0.5 text-xs text-ink-2">
                    {proposal.status === 'ACCEPTED' ? 'Accepted' : 'Rejected'} by{' '}
                    {proposal.decidedByLabel ?? 'a participant'} ·{' '}
                    {formatDateTime(proposal.decidedAt)}
                    {proposal.decisionNote ? ` · ${proposal.decisionNote}` : ''}
                  </p>
                ) : null}

                {proposal.status === 'PENDING' && editable ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {isConfirming ? (
                      <>
                        <Button
                          size="sm"
                          icon={<Check className="h-4 w-4" />}
                          loading={decideMutation.isPending && decideMutation.variables?.id === proposal.id}
                          loadingLabel="Applying…"
                          onClick={() =>
                            decideMutation.mutate({ id: proposal.id, decision: 'ACCEPTED' })
                          }
                        >
                          Confirm and apply this change
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </Button>
                        <span className="text-xs text-ink-2">
                          {status === 'NEGOTIATION'
                            ? 'Applying freezes the current version and records a new one.'
                            : 'This updates the working draft.'}
                        </span>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          icon={<Check className="h-4 w-4" />}
                          onClick={() => setConfirming(proposal.id)}
                        >
                          Accept change
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<X className="h-4 w-4" />}
                          loading={
                            decideMutation.isPending && decideMutation.variables?.id === proposal.id
                          }
                          loadingLabel="Rejecting…"
                          onClick={() =>
                            decideMutation.mutate({ id: proposal.id, decision: 'REJECTED' })
                          }
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                ) : proposal.status === 'PENDING' && suggestable ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={
                        decideMutation.isPending && decideMutation.variables?.id === proposal.id
                      }
                      loadingLabel="Rejecting…"
                      onClick={() =>
                        decideMutation.mutate({ id: proposal.id, decision: 'REJECTED' })
                      }
                    >
                      Reject
                    </Button>
                    <span className="text-xs text-ink-2">
                      Accepting is limited to parties with edit rights.
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Form that raises a new suggestion (never mutates the document). */
function SuggestionForm({
  detail,
  templateDefinition,
  targetLabel,
  onCreated,
}: {
  detail: AgreementDetailResponse;
  templateDefinition: TemplateDefinition | null;
  targetLabel: (kind: ProposalKind, code: string) => string;
  onCreated: () => void;
}) {
  const agreementId = detail.agreement.id;
  const toast = useToast();
  const [kind, setKind] = useState<ProposalKind>('SECTION');
  const [targetCode, setTargetCode] = useState(detail.sections[0]?.code ?? '');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lastPrefill = useRef('');

  const fieldRows = detail.fields;
  const sectionRows = detail.sections;
  const currentField = fieldRows.find((f) => f.code === targetCode)?.value ?? null;
  const currentSection = sectionRows.find((s) => s.code === targetCode) ?? null;

  // Keep a valid target selected for the chosen kind.
  useEffect(() => {
    if (kind === 'TITLE') {
      if (targetCode !== 'title') setTargetCode('title');
      return;
    }
    const pool = kind === 'SECTION' ? sectionRows : fieldRows;
    if (!pool.some((r) => r.code === targetCode)) {
      setTargetCode(kind === 'SECTION' ? (sectionRows[0]?.code ?? '') : (fieldRows[0]?.code ?? ''));
    }
  }, [kind, targetCode, sectionRows, fieldRows]);

  // Prefill the current value when the target changes (not on background refetches).
  useEffect(() => {
    const key = `${kind}:${targetCode}`;
    if (!targetCode || key === lastPrefill.current) return;
    lastPrefill.current = key;
    if (kind === 'TITLE') setValue(detail.agreement.title);
    else if (kind === 'SECTION') {
      setValue(sectionRows.find((s) => s.code === targetCode)?.body ?? '');
    } else {
      const raw = fieldRows.find((f) => f.code === targetCode)?.value ?? null;
      setValue(raw === null || raw === undefined ? '' : String(raw));
    }
  }, [kind, targetCode, detail.agreement.title, sectionRows, fieldRows]);

  const fieldDef = templateDefinition?.fields.find((f) => f.code === targetCode) ?? null;
  const widget: FieldWidget =
    kind !== 'FIELD'
      ? 'textarea'
      : typeof currentField === 'boolean'
        ? 'toggle'
        : typeof currentField === 'number'
          ? 'number'
          : fieldDef?.type === 'toggle'
            ? 'toggle'
            : fieldDef?.type === 'select'
              ? 'select'
              : fieldDef?.type === 'textarea'
                ? 'textarea'
                : fieldDef?.type === 'number' || fieldDef?.type === 'money'
                  ? 'number'
                  : 'text';

  const mutation = useMutation({
    mutationFn: (proposedValue: unknown) =>
      post('/proposals', {
        agreementId,
        kind,
        targetCode,
        proposedValue,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Suggestion recorded. Nothing changes until someone accepts it.');
      setError(null);
      setNote('');
      onCreated();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not record the suggestion.'),
  });

  function buildValue(): { value: unknown; error?: string } {
    if (kind === 'TITLE') {
      const title = value.trim();
      return title ? { value: title } : { value: null, error: 'Enter a proposed title.' };
    }
    if (kind === 'SECTION') {
      return value.trim() ? { value: { body: value } } : { value: null, error: 'Enter the proposed section text.' };
    }
    if (widget === 'toggle') return { value: value === 'true' };
    if (widget === 'number') {
      const n = Number(value.trim());
      if (value.trim() === '' || !Number.isFinite(n)) {
        return { value: null, error: 'Enter a valid number.' };
      }
      return { value: n };
    }
    return { value };
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!targetCode) return;
    const built = buildValue();
    if (built.error) {
      setError(built.error);
      return;
    }
    mutation.mutate(built.value);
  }

  const showTarget = kind !== 'TITLE';

  return (
    <form onSubmit={onSubmit} className="space-y-3 border-b border-rule px-5 py-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Suggest a change to"
          value={kind}
          onChange={(e) => setKind(e.target.value as ProposalKind)}
        >
          <option value="SECTION">Section</option>
          <option value="FIELD">Field</option>
          <option value="TITLE">Agreement title</option>
        </Select>

        {showTarget ? (
          <Select
            label={kind === 'SECTION' ? 'Section' : 'Field'}
            value={targetCode}
            onChange={(e) => setTargetCode(e.target.value)}
          >
            {(kind === 'SECTION' ? sectionRows : fieldRows).map((row) => (
              <option key={row.code} value={row.code}>
                {kind === 'SECTION'
                  ? (row as { title: string }).title
                  : targetLabel('FIELD', row.code)}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {widget === 'textarea' ? (
        <Textarea
          label={kind === 'SECTION' ? 'Proposed section text' : 'Proposed value'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          error={error}
          hint="Shown side by side with the current text; applied only on accept."
        />
      ) : widget === 'toggle' ? (
        <Select
          label="Proposed value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error}
        >
          <option value="true">Yes / true</option>
          <option value="false">No / false</option>
        </Select>
      ) : widget === 'select' ? (
        <Select
          label="Proposed value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error}
        >
          <option value="">Choose…</option>
          {(fieldDef?.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          label={kind === 'TITLE' ? 'Proposed title' : 'Proposed value'}
          inputMode={widget === 'number' ? 'decimal' : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error}
          hint={
            kind === 'SECTION'
              ? undefined
              : 'A suggestion only. It is applied when someone accepts it.'
          }
        />
      )}

      <Input
        label="Reason / note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why this change matters…"
        maxLength={2000}
      />

      <div className="flex justify-end">
        <Button
          type="submit"
          icon={<Lightbulb className="h-4 w-4" />}
          loading={mutation.isPending}
          loadingLabel="Suggesting…"
          disabled={!targetCode}
        >
          Suggest change
        </Button>
      </div>
    </form>
  );
}
