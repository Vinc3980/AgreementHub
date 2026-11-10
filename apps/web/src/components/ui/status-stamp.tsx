import type { AgreementStatus, VersionStatus } from '@agreementhub/domain';
import { statusLabel, versionLabel } from '@/lib/format';

/**
 * Status stamps replace pill badges. Every status has its own glyph *and*
 * label, so the UI still reads in greyscale. Glyphs are inline SVG (never
 * Unicode, never an icon library).
 */

type StampTone = 'neutral' | 'attention' | 'seal' | 'danger';

const STATUS_TONE: Record<string, StampTone> = {
  DRAFT: 'neutral',
  REVIEW: 'attention',
  NEGOTIATION: 'attention',
  AWAITING_SIGNATURES: 'attention',
  EXPIRING: 'attention',
  ACTIVE: 'seal',
  EXPIRED: 'neutral',
  CANCELLED: 'danger',
  TERMINATED: 'danger',
  REJECTED: 'danger',
};

const TONE_CLASS: Record<StampTone, string> = {
  neutral: 'border-rule-strong text-ink-2 bg-transparent',
  attention: 'border-attention-rule text-attention bg-attention-tint',
  seal: 'border-seal-rule text-seal bg-seal-tint',
  danger: 'border-danger-rule text-danger bg-danger-tint',
};

const TONE_GLYPH: Record<StampTone, string> = {
  neutral: 'text-ink-3',
  attention: 'text-attention',
  seal: 'text-seal',
  danger: 'text-danger',
};

export type GlyphName =
  | 'draft'
  | 'review'
  | 'negotiation'
  | 'signature'
  | 'active'
  | 'expiring'
  | 'expired'
  | 'cancelled'
  | 'terminated'
  | 'rejected'
  | 'approved'
  | 'superseded';

export function StatusGlyph({
  name,
  className = 'h-3.5 w-3.5',
}: {
  name: GlyphName;
  className?: string;
}) {
  const common = {
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const,
    className,
    'aria-hidden': true,
  };
  switch (name) {
    case 'draft':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" strokeDasharray="1.6 2" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'negotiation':
      return (
        <svg {...common}>
          <path d="M2.5 5.5h9M8.8 3l2.7 2.5L8.8 8" />
          <path d="M13.5 10.5h-9M7.2 8l-2.7 2.5L7.2 13" />
        </svg>
      );
    case 'signature':
      return (
        <svg {...common}>
          <path d="M9.8 2.6 12.4 5 6.1 11.3l-3.4 1 1-3.4Z" />
          <path d="M2.5 14h11" />
        </svg>
      );
    case 'active':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="6.4" strokeWidth={0.8} />
        </svg>
      );
    case 'expiring':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5H8Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'expired':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" strokeDasharray="1.4 1.6" />
          <path d="M4.6 11.4 11.4 4.6" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M4.3 11.7 11.7 4.3" />
        </svg>
      );
    case 'terminated':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'rejected':
      return (
        <svg {...common}>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      );
    case 'approved':
      return (
        <svg {...common}>
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      );
    case 'superseded':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
        </svg>
      );
  }
}

function glyphForStatus(status: string): GlyphName {
  switch (status) {
    case 'DRAFT':
      return 'draft';
    case 'REVIEW':
      return 'review';
    case 'NEGOTIATION':
      return 'negotiation';
    case 'AWAITING_SIGNATURES':
      return 'signature';
    case 'ACTIVE':
      return 'active';
    case 'EXPIRING':
      return 'expiring';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
    case 'TERMINATED':
      return 'terminated';
    case 'REJECTED':
      return 'rejected';
    default:
      return 'draft';
  }
}

export function StatusStamp({
  status,
  className = '',
}: {
  status: AgreementStatus | string;
  className?: string;
}) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  const glyph = glyphForStatus(status);
  return (
    <span
      className={[
        'inline-flex min-h-6 items-center gap-1.5 rounded-control border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        className,
      ].join(' ')}
      title={statusLabel(status)}
    >
      <StatusGlyph name={glyph} className={`h-3.5 w-3.5 shrink-0 ${TONE_GLYPH[tone]}`} />
      {statusLabel(status)}
    </span>
  );
}

const VERSION_TONE: Record<string, StampTone> = {
  DRAFT: 'neutral',
  SUPERSEDED: 'neutral',
  PENDING_APPROVAL: 'attention',
  APPROVED: 'neutral',
  FINAL: 'seal',
  REJECTED: 'danger',
};

const VERSION_GLYPH: Record<string, GlyphName> = {
  DRAFT: 'draft',
  SUPERSEDED: 'superseded',
  PENDING_APPROVAL: 'review',
  APPROVED: 'approved',
  FINAL: 'active',
  REJECTED: 'rejected',
};

export function VersionStamp({ status }: { status: VersionStatus | string }) {
  const tone = VERSION_TONE[status] ?? 'neutral';
  return (
    <span
      className={[
        'inline-flex min-h-6 items-center gap-1.5 rounded-control border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[tone],
      ].join(' ')}
    >
      <StatusGlyph
        name={VERSION_GLYPH[status] ?? 'draft'}
        className={`h-3.5 w-3.5 shrink-0 ${TONE_GLYPH[tone]}`}
      />
      {versionLabel(status)}
    </span>
  );
}
