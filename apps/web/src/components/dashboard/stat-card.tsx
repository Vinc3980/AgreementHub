import Link from 'next/link';
import type { ReactNode } from 'react';

/** KPI tile used on the dashboard. Links to the matching filtered list. */
export function StatCard({
  label,
  value,
  icon,
  hint,
  href,
  tone = 'neutral',
  emphasis = false,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  hint?: string;
  href: string;
  tone?: 'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger';
  emphasis?: boolean;
}) {
  const toneClass = {
    neutral: 'bg-vellum text-ink-2',
    brand: 'bg-navy-tint text-navy',
    info: 'bg-navy-tint text-navy',
    success: 'bg-seal-tint text-seal',
    warning: 'bg-attention-tint text-attention',
    danger: 'bg-danger-tint text-danger',
  }[tone];

  return (
    <Link
      href={href}
      className={[
        'group rounded-panel border bg-sheet p-4 transition-colors sm:p-5',
        emphasis ? 'border-navy ring-1 ring-navy/20' : 'border-rule hover:border-rule-strong',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-ink-2">{label}</p>
        <span className={`rounded-control p-1.5 ${toneClass}`} aria-hidden>
          {icon}
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink tabular-nums">
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-xs text-ink-3">{hint}</p> : null}
    </Link>
  );
}
