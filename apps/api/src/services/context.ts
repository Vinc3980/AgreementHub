/**
 * Shared service context: who is acting and under what request.
 * Passed to every service call so audit events capture actor + request refs.
 */
export interface ActorContext {
  userId: string;
  email: string;
  displayName: string;
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export function auditActor(ctx: ActorContext) {
  return { type: 'USER' as const, id: ctx.userId, label: ctx.email };
}
