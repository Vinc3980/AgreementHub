/** Status/label badges and small chips, rectangular stamps, never pills. */
import type { ReactNode } from 'react';
import type { Tone } from '@/lib/format';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-vellum text-ink-2 border-rule-strong',
  info: 'bg-navy-tint text-navy border-rule-strong',
  brand: 'bg-navy-tint text-navy border-navy/40',
  success: 'bg-seal-tint text-seal border-seal-rule',
  warning: 'bg-attention-tint text-attention border-attention-rule',
  danger: 'bg-danger-tint text-danger border-danger-rule',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-control border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

/** Small-caps section label used inside panels. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-caps text-ink-3">{children}</h3>;
}
