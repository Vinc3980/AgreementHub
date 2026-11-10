/**
 * Agreement lifecycle, single source of truth for statuses and legal
 * transitions (SPEC §10.2). Enforced by AgreementLifecycleService and
 * re-checked in the API layer; illegal transitions produce INVALID_TRANSITION.
 */

export const AGREEMENT_STATUSES = [
  'DRAFT',
  'REVIEW',
  'NEGOTIATION',
  'AWAITING_SIGNATURES',
  'ACTIVE',
  'EXPIRING',
  'EXPIRED',
  'CANCELLED',
  'TERMINATED',
  'REJECTED',
] as const;

export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly AgreementStatus[] = [
  'EXPIRED',
  'CANCELLED',
  'TERMINATED',
  'REJECTED',
];

export function isTerminal(status: AgreementStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Who may trigger a given transition (spec §10.2 guards). */
export type TransitionActor =
  | 'OWNER' // agreement owner / org OWNER-ADMIN-CREATOR
  | 'REVIEWER'
  | 'SYSTEM' // scheduler
  | 'SIGNER';

export interface TransitionRule {
  from: AgreementStatus;
  to: AgreementStatus;
  /** Actors permitted to trigger; SYSTEM rules are scheduler-only. */
  actors: readonly TransitionActor[];
  /** Human-readable trigger used in error messages and audit metadata. */
  trigger: string;
  reasonRequired?: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'DRAFT', to: 'REVIEW', actors: ['OWNER'], trigger: 'submit for review' },
  { from: 'REVIEW', to: 'DRAFT', actors: ['OWNER', 'REVIEWER'], trigger: 'changes requested' },
  { from: 'REVIEW', to: 'NEGOTIATION', actors: ['OWNER', 'REVIEWER'], trigger: 'counterparty proposes edits' },
  { from: 'REVIEW', to: 'AWAITING_SIGNATURES', actors: ['OWNER', 'SYSTEM'], trigger: 'all approvals recorded' },
  { from: 'REVIEW', to: 'REJECTED', actors: ['REVIEWER'], trigger: 'reviewer rejects', reasonRequired: true },
  { from: 'NEGOTIATION', to: 'REVIEW', actors: ['OWNER', 'REVIEWER'], trigger: 'new version submitted' },
  { from: 'NEGOTIATION', to: 'AWAITING_SIGNATURES', actors: ['OWNER', 'SYSTEM'], trigger: 'all approvals recorded' },
  { from: 'NEGOTIATION', to: 'REJECTED', actors: ['REVIEWER'], trigger: 'reviewer rejects', reasonRequired: true },
  { from: 'AWAITING_SIGNATURES', to: 'ACTIVE', actors: ['SIGNER', 'SYSTEM'], trigger: 'all required signatures collected' },
  { from: 'AWAITING_SIGNATURES', to: 'REJECTED', actors: ['SIGNER', 'OWNER'], trigger: 'signatory declines', reasonRequired: true },
  { from: 'AWAITING_SIGNATURES', to: 'CANCELLED', actors: ['OWNER'], trigger: 'cancel', reasonRequired: true },
  { from: 'ACTIVE', to: 'EXPIRING', actors: ['SYSTEM'], trigger: 'expiry approach (scheduler)' },
  // Amendment workflow: a sealed agreement may only be re-opened through the
  // dedicated amendment endpoint (which seeds a new version from the final
  // document first), the generic status route refuses this pair.
  { from: 'ACTIVE', to: 'NEGOTIATION', actors: ['OWNER'], trigger: 'start amendment' },
  { from: 'ACTIVE', to: 'EXPIRED', actors: ['SYSTEM'], trigger: 'expiry date reached (scheduler)' },
  { from: 'ACTIVE', to: 'TERMINATED', actors: ['OWNER'], trigger: 'terminate', reasonRequired: true },
  { from: 'ACTIVE', to: 'CANCELLED', actors: ['OWNER'], trigger: 'cancel', reasonRequired: true },
  { from: 'EXPIRING', to: 'ACTIVE', actors: ['OWNER', 'SYSTEM'], trigger: 'renewed / extended' },
  { from: 'EXPIRING', to: 'EXPIRED', actors: ['SYSTEM'], trigger: 'expiry date reached (scheduler)' },
  { from: 'EXPIRING', to: 'TERMINATED', actors: ['OWNER'], trigger: 'terminate', reasonRequired: true },
  { from: 'EXPIRING', to: 'CANCELLED', actors: ['OWNER'], trigger: 'cancel', reasonRequired: true },
  // Cancellation is allowed from any non-terminal state (spec §10.2).
  { from: 'DRAFT', to: 'CANCELLED', actors: ['OWNER'], trigger: 'cancel', reasonRequired: true },
  { from: 'REVIEW', to: 'CANCELLED', actors: ['OWNER'], trigger: 'cancel', reasonRequired: true },
  { from: 'NEGOTIATION', to: 'CANCELLED', actors: ['OWNER'], trigger: 'cancel', reasonRequired: true },
];

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(
    readonly from: AgreementStatus,
    readonly to: AgreementStatus,
    detail?: string,
  ) {
    super(
      detail ??
        `Invalid agreement status transition ${from} → ${to}. Allowed from ${from}: ${
          allowedTransitions(from)
            .map((t) => t.to)
            .join(', ') || '(none)'
        }.`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function findTransition(
  from: AgreementStatus,
  to: AgreementStatus,
): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function allowedTransitions(from: AgreementStatus): TransitionRule[] {
  return TRANSITIONS.filter((t) => t.from === from);
}

/**
 * Validate a transition. Throws InvalidTransitionError when illegal or when the
 * actor lacks permission. Returns the rule on success.
 */
export function assertTransition(
  from: AgreementStatus,
  to: AgreementStatus,
  actor: TransitionActor,
  options: { reason?: string | null } = {},
): TransitionRule {
  if (from === to) throw new InvalidTransitionError(from, to, `Agreement is already in status ${from}.`);
  const rule = findTransition(from, to);
  if (!rule) throw new InvalidTransitionError(from, to);
  if (!rule.actors.includes(actor)) {
    throw new InvalidTransitionError(
      from,
      to,
      `Actor ${actor} may not trigger "${rule.trigger}" (${from} → ${to}).`,
    );
  }
  if (rule.reasonRequired && !options.reason?.trim()) {
    throw new InvalidTransitionError(from, to, `A reason is required to ${to.toLowerCase()} an agreement.`);
  }
  return rule;
}
