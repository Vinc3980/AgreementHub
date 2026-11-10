import type { ReactNode } from 'react';

/**
 * Marginalia, a note set in the margin, outside the document body.
 * Use for provenance, reviewer notes, and correction history; never for
 * primary actions.
 */
export function Marginalia({
  label,
  children,
  tone = 'neutral',
  className = '',
}: {
  label: ReactNode;
  children: ReactNode;
  tone?: 'neutral' | 'attention' | 'seal' | 'danger';
  className?: string;
}) {
  const toneClass = {
    neutral: 'border-ink-3 text-ink-2',
    attention: 'border-attention text-attention',
    seal: 'border-seal text-seal',
    danger: 'border-danger text-danger',
  }[tone];

  return (
    <aside
      className={`border-l-2 pl-3 ${toneClass} ${className}`}
      aria-label={typeof label === 'string' ? label : undefined}
    >
      <p className="text-caps">{label}</p>
      <div className="mt-1 text-sm leading-relaxed text-ink-2 [&_a]:underline">{children}</div>
    </aside>
  );
}
