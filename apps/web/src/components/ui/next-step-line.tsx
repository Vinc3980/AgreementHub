import { formatDate, relativeTime } from '@/lib/format';

/** One plain sentence answering: what happens now, and who is blocking? */

interface PartyLike {
  display_name?: string | null;
  displayName?: string | null;
  email: string;
  role: string;
  status?: string;
  signed_at?: string | null;
  signedAt?: string | null;
}

export function nextStepFor({
  status,
  pendingAction,
  parties = [],
  expiresAt,
  updatedAt,
  signature,
}: {
  status: string;
  pendingAction?: string | null;
  parties?: PartyLike[];
  expiresAt?: string | null;
  updatedAt?: string | null;
  signature?: { signed: number; required: number } | null;
}): string {
  if (pendingAction === 'SIGN') return 'Needs your signature.';
  if (pendingAction === 'APPROVE') return 'Needs your approval.';
  if (pendingAction === 'REVIEW') return 'Needs your review.';

  if (status === 'DRAFT') return 'Draft: finish the fields, then submit it for review.';
  if (status === 'REVIEW') return 'In review: waiting on the reviewer to advance it.';
  if (status === 'NEGOTIATION') {
    return 'In negotiation: settle suggestions before sending for signature.';
  }

  if (status === 'AWAITING_SIGNATURES') {
    const unsigned = parties.filter(
      (p) =>
        p.role === 'SIGNER' &&
        !(p.signed_at ?? p.signedAt ?? null) &&
        p.status !== 'DECLINED',
    );
    const total =
      signature?.required ?? (unsigned.length || parties.filter((p) => p.role === 'SIGNER').length);
    const remaining =
      signature != null ? Math.max(signature.required - signature.signed, 0) : unsigned.length;
    if (unsigned.length > 0) {
      const names = unsigned
        .slice(0, 2)
        .map((p) => p.display_name ?? p.displayName ?? p.email)
        .join(' and ');
      const more = unsigned.length > 2 ? ` +${unsigned.length - 2} more` : '';
      return `Waiting on ${names}${more} to sign · ${remaining} of ${total || remaining} outstanding.`;
    }
    return `Signatures collected. Ready to seal${updatedAt ? ` · updated ${relativeTime(updatedAt)}` : ''}.`;
  }

  if (status === 'ACTIVE') {
    return expiresAt
      ? `Sealed and active · expires ${formatDate(expiresAt)}.`
      : 'Sealed and active. The public record now verifies this document.';
  }

  if (status === 'EXPIRING') {
    const days = expiresAt
      ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)
      : null;
    return days != null && days >= 0
      ? `Sealed, expiring in ${days} day${days === 1 ? '' : 's'} · renew or amend.`
      : 'Sealed and expiring. Renew or amend before it lapses.';
  }

  if (status === 'EXPIRED') {
    return `Expired${expiresAt ? ` on ${formatDate(expiresAt)}` : ''}. The sealed record and audit trail remain.`;
  }

  if (status === 'CANCELLED') return 'Cancelled. The record is closed and preserved.';
  if (status === 'TERMINATED') return 'Terminated. The record is closed and preserved.';
  if (status === 'REJECTED') return 'Rejected. Revise and submit a new version.';

  return 'Open the record to see the next action.';
}

export function NextStepLine({
  status,
  pendingAction,
  parties,
  expiresAt,
  updatedAt,
  signature,
  className = '',
}: {
  status: string;
  pendingAction?: string | null;
  parties?: PartyLike[];
  expiresAt?: string | null;
  updatedAt?: string | null;
  signature?: { signed: number; required: number } | null;
  className?: string;
}) {
  const attention = Boolean(pendingAction);
  return (
    <p className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm ${className}`}>
      <span className={`text-caps ${attention ? 'text-attention' : 'text-ink-3'}`}>Next</span>
      <span className={attention ? 'text-ink' : 'text-ink-2'}>
        {nextStepFor({ status, pendingAction, parties, expiresAt, updatedAt, signature })}
      </span>
    </p>
  );
}
