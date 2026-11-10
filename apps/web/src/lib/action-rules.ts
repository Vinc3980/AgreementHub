/**
 * Frontend mirror of the backend permission/transition rules (single source of
 * truth: @agreementhub/domain TRANSITIONS + apps/api access rules). Used to
 * decide which buttons to show, the backend re-validates every call anyway.
 */
import {
  allowedTransitions,
  type AgreementStatus,
  type TransitionActor,
  type TransitionRule,
} from '@agreementhub/domain/lifecycle';

export interface ActionContext {
  /** My role in the agreement's organization (null when I'm only a party). */
  orgRole: string | null;
  /** My party role on this agreement (null when I'm only an org member). */
  partyRole: string | null;
}

const MANAGE_ROLES = ['OWNER', 'ADMIN', 'CREATOR'];

/** Maps org/party role to the lifecycle actor table used by the backend. */
export function lifecycleActor(ctx: ActionContext): TransitionActor {
  const isOwner = ctx.orgRole === 'OWNER' || ctx.partyRole === 'OWNER';
  return ctx.orgRole === 'REVIEWER' && !isOwner ? 'REVIEWER' : 'OWNER';
}

export function canManage(ctx: ActionContext): boolean {
  return MANAGE_ROLES.includes(ctx.orgRole ?? '') || ctx.partyRole === 'OWNER';
}

/** Working-copy edit rights: managers always; OWNER/CONTRIBUTOR parties pre-signature. */
export function canEdit(status: AgreementStatus, ctx: ActionContext): boolean {
  const preSign = status === 'DRAFT' || status === 'NEGOTIATION';
  if (preSign && canManage(ctx)) return true;
  if (preSign && ['OWNER', 'CONTRIBUTOR'].includes(ctx.partyRole ?? '')) return true;
  return false;
}

/** Transitions the UI offers for manual use (system-triggered paths excluded). */
const HIDDEN_FROM_UI = new Set([
  'REVIEW>AWAITING_SIGNATURES', // driven by the approval flow, not a manual click
  'NEGOTIATION>AWAITING_SIGNATURES',
  'ACTIVE>NEGOTIATION', // re-opening a sealed deal only goes through the amendment flow
]);

export function manualTransitions(from: AgreementStatus, ctx: ActionContext): TransitionRule[] {
  const actor = lifecycleActor(ctx);
  if (!canManage(ctx) && from !== 'AWAITING_SIGNATURES') return [];
  return allowedTransitions(from).filter(
    (rule) =>
      rule.actors.includes(actor) &&
      rule.actors.some((a) => a !== 'SYSTEM') &&
      !HIDDEN_FROM_UI.has(`${rule.from}>${rule.to}`),
  );
}

export const TRANSITION_LABELS: Record<string, string> = {
  REVIEW: 'Submit for review',
  NEGOTIATION: 'Open negotiation',
  DRAFT: 'Send back to draft',
  REJECTED: 'Reject',
  CANCELLED: 'Cancel agreement',
  TERMINATED: 'Terminate agreement',
  ACTIVE: 'Mark active',
  AWAITING_SIGNATURES: 'Move to signatures',
  EXPIRING: 'Mark expiring',
  EXPIRED: 'Mark expired',
};

export const TRANSITION_DANGER: ReadonlySet<string> = new Set([
  'REJECTED',
  'CANCELLED',
  'TERMINATED',
]);
