'use client';

/**
 * Versions tab: the negotiation timeline (number, date, action, connected by
 * arrows) plus the two-version comparison with added/removed highlighting.
 *
 * Diff semantics: every meaningful modification while a negotiation is open
 * creates a new version, so comparing v(n-1) → v(n) shows exactly what that
 * change did. Word-level highlights come from the shared domain diff.
 */
import { useEffect, useState } from 'react';
import { ArrowDown, GitCompareArrows, Minus, Plus, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { CardSkeleton, EmptyState, ErrorState, staggerStyle } from '@/components/ui/states';
import { VersionBadge } from '@/components/agreements/status-badge';
import { WordDiff } from '@/components/agreements/detail/word-diff';
import { useVersionDiff, useVersions } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { formatDateTime, shortHash, titleCase } from '@/lib/format';
import type { VersionDiff, VersionListItem } from '@/lib/types';

/* ------------------------------ timeline ------------------------------- */

/**
 * The action shown for a version: "Created", "Finalized", or what the change
 * was ("Payment modified"; the backend derives it from the diff).
 */
function actionLabel(version: VersionListItem): string {
  if (version.status === 'FINAL' || version.finalizedAt) return 'Finalized';
  if (version.versionNumber === 1) return 'Created';
  return version.changeSummary || 'Modified';
}

function VersionRow({ version }: { version: VersionListItem }) {
  const action = actionLabel(version);
  const summary =
    version.changeSummary && version.changeSummary !== action && action !== 'Finalized'
      ? version.changeSummary
      : null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-panel border border-rule bg-paper px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-rule bg-vellum text-sm font-semibold text-ink-2 tabular-nums">
        v{version.versionNumber}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{action}</p>
        <p className="mt-0.5 text-xs text-ink-2">
          {summary ? `${summary} · ` : ''}
          {formatDateTime(version.createdAt)} · hash{' '}
          <code className="font-mono">{shortHash(version.documentHash)}</code>
        </p>
      </div>
      <VersionBadge status={version.status} />
    </div>
  );
}

/* ------------------------------- diff rows ----------------------------- */

/** Comparable text for a diff operand (falls back to null for odd shapes). */
function valueText(kind: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('body' in obj) return typeof obj.body === 'string' ? obj.body : null;
    if ('value' in obj) {
      const v = obj.value;
      if (v === null || v === undefined) return null;
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    if ('email' in obj) return String(obj.email);
    if ('title' in obj) return typeof obj.title === 'string' ? obj.title : null;
    void kind;
    return null;
  }
  return String(value);
}

function fallbackText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Non-body deltas of a structured change (section title/included, provenance). */
function ChangeMeta({ change }: { change: VersionDiff['changes'][number] }) {
  if (change.change !== 'modified') return null;
  const from = (change.from ?? {}) as Record<string, unknown>;
  const to = (change.to ?? {}) as Record<string, unknown>;
  const bits: string[] = [];

  if (change.kind === 'section') {
    if (from.title !== to.title) bits.push(`Title: ${String(from.title ?? '—')} → ${String(to.title ?? '—')}`);
    if (from.included !== to.included) {
      bits.push(`Included: ${from.included ? 'yes' : 'no'} → ${to.included ? 'yes' : 'no'}`);
    }
  }
  if (change.kind === 'field' && from.provenance !== to.provenance) {
    bits.push(`Source: ${String(from.provenance ?? '—')} → ${String(to.provenance ?? '—')}`);
  }
  if (bits.length === 0) return null;
  return <p className="text-xs text-ink-2">{bits.join(' · ')}</p>;
}

function ChangeRow({ change }: { change: VersionDiff['changes'][number] }) {
  const tone =
    change.change === 'added'
      ? 'success'
      : change.change === 'removed'
        ? 'danger'
        : 'warning';
  const Icon = change.change === 'added' ? Plus : change.change === 'removed' ? Minus : Pencil;

  const fromText = valueText(change.kind, change.from);
  const toText = valueText(change.kind, change.to);
  const comparable = change.change === 'modified' && fromText !== null && toText !== null;

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-control ${
          tone === 'success'
            ? 'bg-seal-tint text-seal'
            : tone === 'danger'
              ? 'bg-danger-tint text-danger'
              : 'bg-attention-tint text-attention'
        }`}
        aria-hidden
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">
            {titleCase(change.kind)} · {change.code}
          </span>
          <Badge tone={tone}>{change.change}</Badge>
        </div>

        {comparable ? (
          <div className="mt-2 space-y-1.5">
            <ChangeMeta change={change} />
            <WordDiff from={fromText} to={toText} />
          </div>
        ) : change.change === 'modified' ? (
          <div className="mt-1.5 grid gap-1.5 text-xs">
            <p className="rounded-control border border-danger-rule bg-danger-tint px-2.5 py-1.5">
              <span className="font-semibold text-danger">Before:</span>{' '}
              <span className="text-ink-2">{fallbackText(change.from)}</span>
            </p>
            <p className="rounded-control border border-seal-rule bg-seal-tint px-2.5 py-1.5">
              <span className="font-semibold text-seal">After:</span>{' '}
              <span className="text-ink-2">{fallbackText(change.to)}</span>
            </p>
          </div>
        ) : (
          <p className="mt-1 text-xs text-ink-2">
            {fallbackText(change.change === 'added' ? (toText ?? change.to) : (fromText ?? change.from))}
          </p>
        )}
      </div>
    </li>
  );
}

/* -------------------------------- tab ---------------------------------- */

export function VersionsTab({ agreementId }: { agreementId: string }) {
  const versionsQuery = useVersions(agreementId);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');

  const versions = versionsQuery.data?.versions ?? [];
  const showPending = useDelayedPending(versionsQuery.isPending && !versionsQuery.data);

  // Default the comparison to the two most recent versions.
  useEffect(() => {
    if (fromId || versions.length < 2) return;
    setFromId(versions[versions.length - 2]!.id);
    setToId(versions[versions.length - 1]!.id);
  }, [fromId, versions]);

  const from = versions.find((v) => v.id === fromId);
  const to = versions.find((v) => v.id === toId);
  const diffQuery = useVersionDiff(
    fromId && toId && fromId !== toId ? fromId : undefined,
    fromId && toId && fromId !== toId ? toId : undefined,
  );

  if (versionsQuery.isPending) {
    if (!showPending) return <div className="min-h-[12rem]" aria-busy="true" aria-live="polite" />;
    return <CardSkeleton rows={4} />;
  }
  if (versionsQuery.isError) return <ErrorState onRetry={() => versionsQuery.refetch()} />;

  return (
    <div className="space-y-5 content-fade-in">
      {/* Timeline */}
      <div className="border-y border-rule bg-sheet">
        <div className="border-b border-rule px-5 py-4">
          <h3 className="text-base font-semibold text-ink">Version timeline</h3>
          <p className="mt-0.5 text-sm text-ink-2">
            Every meaningful change creates a version; committed versions are immutable. The final
            version is sealed and can only be amended through a new negotiation.
          </p>
        </div>

        {versions.length === 0 ? (
          <div className="px-5 py-8">
            <EmptyState
              title="No versions yet"
              description="The first version is created when you commit your draft."
            />
          </div>
        ) : (
          <ol className="px-5 py-4">
            {versions.map((version, index) => (
              <li key={version.id} className="stagger-item" style={staggerStyle(index)}>
                {index > 0 ? (
                  <div className="flex justify-center py-1.5" aria-hidden>
                    <ArrowDown className="h-4 w-4 text-ink-3" />
                  </div>
                ) : null}
                <VersionRow version={version} />
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Diff viewer */}
      {versions.length >= 2 ? (
        <div className="border-y border-rule bg-sheet">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-4">
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
                <GitCompareArrows className="h-4 w-4 text-navy" aria-hidden />
                Compare versions
              </h3>
              <p className="mt-0.5 text-sm text-ink-2">
                Pick two versions to see what changed. Added and removed words are highlighted.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Older version"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
                className="w-auto"
              >
                <option value="">Older version…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNumber}
                  </option>
                ))}
              </Select>
              <span className="text-sm text-ink-2">→</span>
              <Select
                aria-label="Newer version"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
                className="w-auto"
              >
                <option value="">Newer version…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNumber}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {!fromId || !toId || fromId === toId ? (
            <p className="px-5 py-6 text-sm text-ink-2">
              Select two different versions to load the comparison.
            </p>
          ) : diffQuery.isPending ? (
            <div className="px-5 py-6">
              <CardSkeleton rows={3} />
            </div>
          ) : diffQuery.isError ? (
            <div className="px-5 py-6">
              <ErrorState onRetry={() => diffQuery.refetch()} />
            </div>
          ) : diffQuery.data ? (
            <div className="px-5 py-4">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <Badge tone="danger">Struck through = removed</Badge>
                <Badge tone="success">Highlighted = added</Badge>
                <span>
                  Comparing <b>v{from?.versionNumber}</b> (
                  <code className="font-mono text-xs">{shortHash(diffQuery.data.diff.hashFrom)}</code>) →{' '}
                  <b>v{to?.versionNumber}</b> (
                  <code className="font-mono text-xs">{shortHash(diffQuery.data.diff.hashTo)}</code>)
                  {diffQuery.data.diff.hashFrom === diffQuery.data.diff.hashTo ? (
                    <span className="ml-1 text-attention">· identical content</span>
                  ) : null}
                </span>
              </div>
              {diffQuery.data.diff.changes.length === 0 ? (
                <p className="text-sm text-ink-2">No differences between these versions.</p>
              ) : (
                <ul className="divide-y divide-rule rounded-none border border-rule">
                  {diffQuery.data.diff.changes.map((change, i) => (
                    <ChangeRow key={`${change.kind}-${change.code}-${i}`} change={change} />
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
