import type { AgreementStatus } from '@agreementhub/domain';
import { statusLabel } from '@/lib/format';

/** Four-stop lifecycle: Draft → Review/Negotiate → Signatures → Sealed. */

const STOPS = ['Draft', 'Review / negotiate', 'Signatures', 'Sealed'] as const;

const TERMINAL = new Set(['CANCELLED', 'TERMINATED', 'REJECTED', 'EXPIRED']);

function stopIndex(status: string): number {
  switch (status) {
    case 'DRAFT':
      return 0;
    case 'REVIEW':
    case 'NEGOTIATION':
      return 1;
    case 'AWAITING_SIGNATURES':
      return 2;
    case 'ACTIVE':
    case 'EXPIRING':
    case 'EXPIRED':
      return 3;
    default:
      return 1;
  }
}

export function LifecycleTrack({
  status,
  compact = false,
  reason,
  className = '',
}: {
  status: AgreementStatus | string;
  /** Row-sized variant: stops only, labels for screen readers. */
  compact?: boolean;
  /** Overrides the terminal reason line. */
  reason?: string | null;
  className?: string;
}) {
  const current = stopIndex(status);
  const terminal = TERMINAL.has(status);
  const sealed = current === 3 && !terminal;

  return (
    <div className={className}>
      <ol
        className={`flex items-center ${compact ? 'gap-1' : 'gap-2'}`}
        aria-label={`Lifecycle: ${statusLabel(status)}`}
      >
        {STOPS.map((label, index) => {
          const done = index < current || (index === current && !terminal);
          const isCurrent = index === current;
          const isSealStop = index === 3 && sealed;
          const nodeClass = isSealStop
            ? 'border-seal bg-seal'
            : done
              ? 'border-navy bg-navy'
              : isCurrent && terminal
                ? 'border-ink-3 bg-sheet'
                : 'border-rule-strong bg-sheet';
          return (
            <li key={label} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
              <span className={compact ? 'flex items-center' : 'flex flex-col items-start gap-1'}>
                <span
                  className={[
                    'inline-block h-2.5 w-2.5 shrink-0 border',
                    nodeClass,
                    isCurrent ? 'outline outline-2 outline-offset-2 outline-navy' : '',
                    isCurrent && terminal ? 'outline-danger' : '',
                  ].join(' ')}
                  aria-hidden
                />
                {compact ? (
                  <span className="sr-only">
                    {label}: {done ? 'complete' : isCurrent ? 'current' : 'upcoming'}
                  </span>
                ) : (
                  <span
                    className={[
                      'text-caps whitespace-nowrap',
                      isCurrent ? 'text-ink' : done ? 'text-ink-2' : 'text-ink-3',
                    ].join(' ')}
                  >
                    {label}
                  </span>
                )}
              </span>
              {index < STOPS.length - 1 ? (
                <span
                  className={[
                    'h-px flex-1',
                    index < current ? 'bg-navy' : 'bg-rule',
                    terminal && index >= current ? 'border-t border-dashed border-rule-strong bg-transparent' : '',
                  ].join(' ')}
                  aria-hidden
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {terminal ? (
        <p className={`flex items-center gap-1.5 text-xs text-danger ${compact ? 'mt-1' : 'mt-2'}`}>
          <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
          Track closed · {reason ?? statusLabel(status)}
        </p>
      ) : null}
    </div>
  );
}
