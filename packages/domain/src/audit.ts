/** Audit event type registry (SPEC §11.2). Append-only, new types only. */
export const AUDIT_EVENT_TYPES = [
  'AGREEMENT_CREATED',
  'AGREEMENT_UPDATED',
  'AGREEMENT_SUBMITTED',
  'STATUS_CHANGED',
  'VERSION_CREATED',
  'VERSION_SUBMITTED',
  'PARTY_INVITED',
  'INVITATION_ACCEPTED',
  'PARTY_VIEWED',
  'PARTY_COMMENTED',
  'APPROVAL_REQUESTED',
  'PARTY_APPROVED',
  'PARTY_REJECTED',
  'SIGNATURE_REQUESTED',
  'DOCUMENT_SIGNED',
  'AGREEMENT_FINALIZED',
  'DOCUMENT_GENERATED',
  'DOCUMENT_DOWNLOADED',
  'DOCUMENT_VERIFIED',
  'AGREEMENT_CANCELLED',
  'AGREEMENT_TERMINATED',
  'AGREEMENT_EXPIRED',
  'AGREEMENT_REJECTED',
  'REMINDER_SENT',
  'AI_ASSISTED',
  'ATTACHMENT_ADDED',
  'COMMENT_STATUS_CHANGED',
  'CHANGE_SUGGESTED',
  'CHANGE_ACCEPTED',
  'CHANGE_REJECTED',
  'AMENDMENT_STARTED',
  'EMAIL_VERIFIED',
  'SIGNATURE_OTP_REQUESTED',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export function isAuditEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Event classification (SPEC §11.3):                                   */
/*   USER     : a person acted (viewed, edited, commented, signed…)    */
/*   AGREEMENT: the agreement itself changed lifecycle/state           */
/*   SYSTEM   : automated actors (scheduler, reminders, AI, anonymous) */
/* ------------------------------------------------------------------ */

export type AuditEventCategory = 'USER' | 'AGREEMENT' | 'SYSTEM';

/** Lifecycle/state transitions of the agreement document itself. */
const AGREEMENT_LIFECYCLE_EVENTS: readonly AuditEventType[] = [
  'AGREEMENT_CREATED',
  'AGREEMENT_SUBMITTED',
  'STATUS_CHANGED',
  'VERSION_CREATED',
  'VERSION_SUBMITTED',
  'AGREEMENT_FINALIZED',
  'AGREEMENT_EXPIRED',
  'AMENDMENT_STARTED',
];

/**
 * Classify an audit event for display/export. A system or AI actor always
 * yields SYSTEM regardless of event type; agreement lifecycle events yield
 * AGREEMENT; everything else is USER activity.
 */
export function auditEventCategory(
  eventType: string,
  actorType?: string | null,
): AuditEventCategory {
  if (actorType === 'SYSTEM' || actorType === 'AI') return 'SYSTEM';
  if ((AGREEMENT_LIFECYCLE_EVENTS as readonly string[]).includes(eventType)) return 'AGREEMENT';
  return 'USER';
}
