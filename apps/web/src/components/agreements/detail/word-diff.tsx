'use client';

/**
 * Word-level comparison of two strings with added/removed highlighting.
 * Uses the shared domain diff (packages/domain) so every surface highlights
 * identical edits identically, and the highlighted text always rebuilds the
 * original content (round-trip safe).
 */
import { useMemo } from 'react';
// Subpath import: the package root pulls in node:crypto (hash.ts), which the
// browser bundle must not see, same pattern as @agreementhub/domain/template.
import { diffWords, type DiffToken } from '@agreementhub/domain/diff';

/** Above this we render plain text, highlighting a wall of text helps nobody. */
const MAX_CHARS = 6000;

function Runs({ tokens, op }: { tokens: DiffToken[]; op: 'removed' | 'added' }) {
  return (
    <>
      {tokens.map((t, i) =>
        t.op === op ? (
          <mark
            key={i}
            className={`rounded-control px-0.5 ${
              op === 'removed'
                ? 'bg-danger-tint text-danger line-through decoration-danger/60'
                : 'bg-redline/10 text-redline underline decoration-redline/50'
            }`}
          >
            {t.text}
          </mark>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </>
  );
}

function Truncated({ label, tone, text }: { label: string; tone: 'danger' | 'added'; text: string }) {
  return (
    <p
      className={`rounded-control border px-2.5 py-1.5 ${
        tone === 'danger' ? 'border-danger-rule bg-danger-tint' : 'border-redline/40 bg-redline/5'
      }`}
    >
      <span className={`font-semibold ${tone === 'danger' ? 'text-danger' : 'text-redline'}`}>
        {label}:
      </span>{' '}
      <span className="text-ink-2">{text.length > 300 ? `${text.slice(0, 300)}…` : text}</span>
    </p>
  );
}

/**
 * Shows `from` and `to` side by side (stacked) with removed words struck
 * through in the "before" copy and added words highlighted in the "after" copy.
 * Falls back to plain text when either side is empty or the text is very long.
 */
export function WordDiff({ from, to }: { from: string; to: string }) {
  const diff = useMemo(() => {
    if (from === to) return null;
    if (Math.max(from.length, to.length) > MAX_CHARS) return null;
    return diffWords(from, to);
  }, [from, to]);

  if (!diff) {
    if (from === to) return <span className="text-ink-2">{from || '—'}</span>;
    return (
      <div className="grid gap-1.5">
        <Truncated label="Before" tone="danger" text={from} />
        <Truncated label="After" tone="added" text={to} />
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <p className="rounded-control border border-danger-rule bg-danger-tint px-2.5 py-1.5 leading-relaxed">
        <span className="font-semibold text-danger">Before: </span>
        <span className="whitespace-pre-wrap text-ink">
          <Runs tokens={diff.before} op="removed" />
        </span>
      </p>
      <p className="rounded-control border border-redline/40 bg-redline/5 px-2.5 py-1.5 leading-relaxed">
        <span className="font-semibold text-redline">After: </span>
        <span className="whitespace-pre-wrap text-ink">
          <Runs tokens={diff.after} op="added" />
        </span>
      </p>
    </div>
  );
}
