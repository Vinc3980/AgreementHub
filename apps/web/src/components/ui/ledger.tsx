import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatDateTime } from '@/lib/format';

/**
 * LedgerRow, one event in the audit trail, set as a ruled ledger line:
 * sequence number, timestamp, actor, event, category, hash. No cards.
 */

const CATEGORY_TONE: Record<string, string> = {
  USER: 'text-navy',
  AGREEMENT: 'text-ink',
  SYSTEM: 'text-ink-3',
};

export function LedgerRow({
  seq,
  occurredAt,
  actor,
  event,
  category,
  hash,
  href,
  detail,
  last = false,
}: {
  seq: number | null;
  occurredAt: string;
  actor: ReactNode;
  event: ReactNode;
  category?: string | null;
  hash?: string | null;
  href?: string;
  detail?: ReactNode;
  last?: boolean;
}) {
  const body = (
    <>
      <span className="flex shrink-0 items-baseline gap-2 sm:w-24">
        <span className="font-mono text-xs text-ink-3 tabular-nums">
          {seq != null ? String(seq).padStart(4, '0') : '—'}
        </span>
        <time
          dateTime={occurredAt}
          className="font-mono text-2xs text-ink-3 tabular-nums"
          title={formatDateTime(occurredAt)}
        >
          {occurredAt.slice(11, 19)}
        </time>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{event}</span>
        <span className="mt-0.5 block text-xs text-ink-2">
          {actor}
          {category ? (
            <span className={`ml-2 text-caps ${CATEGORY_TONE[category] ?? 'text-ink-3'}`}>
              {category.toLowerCase()}
            </span>
          ) : null}
        </span>
        {detail ? <span className="mt-1 block text-xs text-ink-2">{detail}</span> : null}
      </span>
      {hash ? (
        <span className="hidden shrink-0 font-mono text-2xs text-ink-3 sm:block" title={hash}>
          {hash.slice(0, 8)}
        </span>
      ) : null}
    </>
  );

  return (
    <li className={last ? '' : 'border-b border-rule'}>
      {href ? (
        <Link
          href={href}
          className="flex flex-wrap items-start gap-x-4 gap-y-1 px-1 py-3 hover:bg-vellum/60"
        >
          {body}
        </Link>
      ) : (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1 px-1 py-3">{body}</div>
      )}
    </li>
  );
}
