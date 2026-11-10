/**
 * Display formatting: status/version labels + tones, dates, relative time,
 * audit event labels. Centralized so badges and lists stay consistent.
 */
import type { AgreementStatus, VersionStatus } from '@agreementhub/domain';

export type Tone = 'neutral' | 'info' | 'brand' | 'success' | 'warning' | 'danger';

/* ------------------------------- statuses ---------------------------- */

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  REVIEW: 'In review',
  NEGOTIATION: 'In negotiation',
  AWAITING_SIGNATURES: 'Awaiting signatures',
  ACTIVE: 'Active',
  EXPIRING: 'Expiring',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  TERMINATED: 'Terminated',
  REJECTED: 'Rejected',
};

const STATUS_TONES: Record<AgreementStatus, Tone> = {
  DRAFT: 'neutral',
  REVIEW: 'warning',
  NEGOTIATION: 'warning',
  AWAITING_SIGNATURES: 'info',
  ACTIVE: 'success',
  EXPIRING: 'warning',
  EXPIRED: 'danger',
  CANCELLED: 'danger',
  TERMINATED: 'danger',
  REJECTED: 'danger',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusTone(status: AgreementStatus): Tone {
  return STATUS_TONES[status] ?? 'neutral';
}

/** Compact list-tab label (spec example: "Awaiting Signature"). */
export function statusShortLabel(status: string): string {
  switch (status) {
    case 'AWAITING_SIGNATURES':
      return 'Awaiting signature';
    case 'REVIEW':
      return 'Review';
    case 'NEGOTIATION':
      return 'Negotiation';
    default:
      return statusLabel(status);
  }
}

/* ------------------------------- versions ---------------------------- */

const VERSION_LABELS: Record<string, string> = {
  DRAFT: 'Working draft',
  SUPERSEDED: 'Superseded',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  FINAL: 'Final · sealed',
  REJECTED: 'Rejected',
};

const VERSION_TONES: Record<VersionStatus, Tone> = {
  DRAFT: 'neutral',
  SUPERSEDED: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  FINAL: 'success',
  REJECTED: 'danger',
};

export function versionLabel(status: string): string {
  return VERSION_LABELS[status] ?? status;
}

export function versionTone(status: VersionStatus): Tone {
  return VERSION_TONES[status] ?? 'neutral';
}

/* ---------------------------- pending actions ------------------------ */

export const ACTION_LABELS: Record<string, string> = {
  SIGN: 'Sign agreement',
  APPROVE: 'Record approval',
  REVIEW: 'Review & advance',
};

export const ACTION_DESCRIPTIONS: Record<string, string> = {
  SIGN: 'Your signature is required to finalize this agreement.',
  APPROVE: 'This version is waiting for your approval decision.',
  REVIEW: 'Submitted for review. Open it to request approvals or send it back.',
};

/* ------------------------------ audit labels ------------------------- */

export const EVENT_LABELS: Record<string, string> = {
  AGREEMENT_CREATED: 'Agreement created',
  AGREEMENT_UPDATED: 'Draft updated',
  AGREEMENT_SUBMITTED: 'Submitted for review',
  STATUS_CHANGED: 'Status changed',
  VERSION_CREATED: 'New version created',
  VERSION_SUBMITTED: 'Version submitted',
  PARTY_INVITED: 'Party invited',
  INVITATION_ACCEPTED: 'Invitation accepted',
  PARTY_VIEWED: 'Document viewed',
  PARTY_COMMENTED: 'Comment added',
  APPROVAL_REQUESTED: 'Approval requested',
  PARTY_APPROVED: 'Approval recorded',
  PARTY_REJECTED: 'Approval rejected',
  SIGNATURE_REQUESTED: 'Signature requested',
  DOCUMENT_SIGNED: 'Document signed',
  AGREEMENT_FINALIZED: 'Agreement finalized',
  DOCUMENT_GENERATED: 'Final PDF generated',
  DOCUMENT_DOWNLOADED: 'Document downloaded',
  DOCUMENT_VERIFIED: 'Integrity verified',
  AGREEMENT_CANCELLED: 'Agreement cancelled',
  AGREEMENT_TERMINATED: 'Agreement terminated',
  AGREEMENT_EXPIRED: 'Agreement expired',
  AGREEMENT_REJECTED: 'Agreement rejected',
  REMINDER_SENT: 'Reminder sent',
  AI_ASSISTED: 'AI assistance used',
  ATTACHMENT_ADDED: 'Attachment added',
  COMMENT_STATUS_CHANGED: 'Comment status changed',
  CHANGE_SUGGESTED: 'Change suggested',
  CHANGE_ACCEPTED: 'Change accepted',
  CHANGE_REJECTED: 'Change rejected',
  CHANGE_DECIDED: 'Change decision recorded',
  AMENDMENT_STARTED: 'Amendment started',
  OBLIGATION_REMINDER: 'Obligation reminder',
  OBLIGATION_OVERDUE: 'Obligation overdue',
};

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function obligationStatusLabel(status: string): string {
  switch (status) {
    case 'UPCOMING': return 'Upcoming';
    case 'DUE_SOON': return 'Due soon';
    case 'OVERDUE': return 'Overdue';
    case 'COMPLETED': return 'Completed';
    case 'CANCELLED': return 'Cancelled';
    default: return status;
  }
}

export function obligationStatusTone(status: string): Tone {
  switch (status) {
    case 'COMPLETED': return 'success';
    case 'OVERDUE': return 'danger';
    case 'DUE_SOON': return 'warning';
    case 'CANCELLED': return 'neutral';
    default: return 'info';
  }
}

/** Signing method labels, shown on signature records and sign results. */
export const SIGNING_METHOD_LABELS: Record<string, string> = {
  TYPED: 'Typed name',
  DRAWN: 'Drawn signature',
  CONSENT: 'Explicit acceptance',
  SESSION: 'Authenticated session',
  EMAIL_OTP: 'Email one-time code',
};

export function signingMethodLabel(method: string): string {
  return SIGNING_METHOD_LABELS[method] ?? method;
}

/** Audit event classes (user activity / agreement events / system events). */
export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  USER: 'User activity',
  AGREEMENT: 'Agreement event',
  SYSTEM: 'System event',
};

export function auditCategoryLabel(category: string): string {
  return AUDIT_CATEGORY_LABELS[category] ?? category;
}

/* -------------------------------- dates ------------------------------ */

export const DEFAULT_LOCALE = 'en-GH';
export const DEFAULT_TIMEZONE = 'Africa/Accra'; // GMT (UTC+0) year-round

let _resolvedLocale: string | null = null;
function locale(): string {
  if (_resolvedLocale) return _resolvedLocale;
  for (const candidate of [DEFAULT_LOCALE, 'en-GB']) {
    try {
      // Verify the runtime can format with this locale.
      new Intl.DateTimeFormat(candidate, { day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date('2026-01-01T00:00:00Z'),
      );
      _resolvedLocale = candidate;
      return candidate;
    } catch {
      /* try next */
    }
  }
  _resolvedLocale = 'en-GB';
  return _resolvedLocale;
}

/** Unambiguous day-month-year date (e.g. 9 November 2026), displayed in Africa/Accra. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale(), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: DEFAULT_TIMEZONE,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(d);
  }
}

/** Human-readable date for helper text (e.g. "31 December 2026"). */
export function formatDateLong(isoOrDate: string | Date | null | undefined): string {
  if (!isoOrDate) return '—';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '—';
  return formatDate(d.toISOString());
}

/** Timestamp displayed in Africa/Accra (GMT, UTC+0 year-round) with an explicit GMT label. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    const formatted = new Intl.DateTimeFormat(locale(), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: DEFAULT_TIMEZONE,
    }).format(d);
    return `${formatted} GMT`;
  } catch {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }).format(d);
    return `${formatted} GMT`;
  }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 3600_000],
    ['month', 30 * 24 * 3600_000],
    ['day', 24 * 3600_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(-Math.round(abs / ms), unit);
  }
  try {
    return rtf.format(0, 'second');
  } catch {
    return 'just now';
  }
}

export function initials(name: string | null | undefined, fallback = 'U'): string {
  const src = (name ?? '').trim();
  if (!src) return fallback;
  const parts = src.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return `${hash.slice(0, 10)}…`;
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
