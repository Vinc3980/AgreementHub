'use client';

/** Mono hash, grouped in blocks of four. First 8 characters emphasised. */
import { useState } from 'react';

function group(value: string): string[] {
  const clean = value.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += 4) out.push(clean.slice(i, i + 4));
  return out;
}

export function HashText({
  value,
  label,
  className = '',
  copyable = true,
  blocks = 0,
}: {
  value: string | null | undefined;
  label?: string;
  className?: string;
  copyable?: boolean;
  /** Limit visible blocks (0 = full value). */
  blocks?: number;
}) {
  const [copied, setCopied] = useState(false);
  const full = (value ?? '').trim();
  const groups = group(full);
  const visible = blocks > 0 ? groups.slice(0, blocks) : groups;

  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  if (!full) {
    return <span className={`font-mono text-xs text-ink-3 ${className}`}>—</span>;
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      {label ? <span className="text-caps text-ink-3">{label}</span> : null}
      <span className="font-mono text-xs tracking-[0.02em] break-all text-ink-3" aria-label={full}>
        {visible.map((chunk, i) => (
          <span
            key={i}
            className={i < 2 ? 'font-semibold text-ink' : undefined}
          >
            {chunk}
            {i < visible.length - 1 ? ' ' : ''}
          </span>
        ))}
        {blocks > 0 && groups.length > blocks ? <span aria-hidden> …</span> : null}
      </span>
      {copyable ? (
        <button
          type="button"
          onClick={() => void copy()}
          className="min-h-9 rounded-control border border-rule px-2 text-[0.6875rem] font-medium text-ink-2 hover:border-rule-strong hover:text-ink"
          aria-label={copied ? 'Hash copied' : 'Copy hash to clipboard'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      ) : null}
    </span>
  );
}
