/**
 * Agreement access control (SPEC §9, deny-by-default).
 *
 * Visibility: an agreement is visible if the user holds an active membership
 * in its organization (with role-based read rules) OR is a linked party.
 * Not visible ⇒ 404 (no IDOR existence leak); visible but insufficient
 * permission ⇒ 403.
 */
import { AppError, type AgreementStatus } from '@agreementhub/domain';
import type pg from 'pg';
import { many, one, type Queryable } from '../db.js';

export type OrgRole = 'OWNER' | 'ADMIN' | 'CREATOR' | 'REVIEWER' | 'MEMBER';
export type PartyRole = 'OWNER' | 'CONTRIBUTOR' | 'REVIEWER' | 'SIGNER' | 'OBSERVER';

/** Org roles that can read any agreement in the org (spec matrix). */
const READ_ROLES: readonly OrgRole[] = ['OWNER', 'ADMIN', 'CREATOR', 'REVIEWER'];
/** Org roles that can create/manage agreements (invite, cancel, finalize…). */
const MANAGE_ROLES: readonly OrgRole[] = ['OWNER', 'ADMIN', 'CREATOR'];

/** Party roles allowed to approve a version. */
const APPROVER_ROLES: readonly PartyRole[] = ['OWNER', 'CONTRIBUTOR', 'REVIEWER', 'SIGNER'];
/** Party roles whose signature is required before finalization. */
export const SIGNER_ROLES: readonly PartyRole[] = ['OWNER', 'SIGNER'];

export interface AgreementRow {
  id: string;
  public_id: string;
  org_id: string;
  title: string;
  category_id: string;
  template_id: string;
  template_version: number;
  status: AgreementStatus;
  brief: string | null;
  current_version_id: string | null;
  final_version_id: string | null;
  created_by: string;
  expires_at: Date | null;
  finalized_at: Date | null;
  closed_reason: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface PartyRow {
  id: string;
  agreement_id: string;
  user_id: string | null;
  email: string;
  display_name: string;
  role: PartyRole;
  signing_order: number;
  status: 'INVITED' | 'VIEWED' | 'APPROVED' | 'SIGNED' | 'DECLINED';
  added_by: string | null;
  added_at: Date;
  signed_at: Date | null;
}

export interface MembershipRow {
  org_id: string;
  user_id: string;
  role: OrgRole;
  status: string;
}

export interface AgreementAccess {
  agreement: AgreementRow;
  membership: MembershipRow | null;
  party: PartyRow | null;
}

export async function getMembership(
  db: Queryable,
  userId: string,
  orgId: string,
): Promise<MembershipRow | null> {
  const row = await one<MembershipRow>(
    db,
    `SELECT org_id, user_id, role, status FROM organization_members
     WHERE user_id = $1 AND org_id = $2 AND status = 'ACTIVE'`,
    [userId, orgId],
  );
  return row ?? null;
}

export async function loadAgreementRow(
  db: Queryable,
  agreementId: string,
): Promise<AgreementRow | undefined> {
  return one<AgreementRow>(
    db,
    `SELECT * FROM agreements WHERE id = $1 AND deleted_at IS NULL`,
    [agreementId],
  );
}

export async function listParties(
  db: Queryable,
  agreementId: string,
): Promise<PartyRow[]> {
  return many<PartyRow>(
    db,
    `SELECT * FROM agreement_parties WHERE agreement_id = $1 ORDER BY signing_order, added_at`,
    [agreementId],
  );
}

export async function findPartyForUser(
  db: Queryable,
  agreementId: string,
  userId: string,
  email: string,
): Promise<PartyRow | null> {
  const row = await one<PartyRow>(
    db,
    `SELECT * FROM agreement_parties
     WHERE agreement_id = $1 AND (user_id = $2 OR lower(email) = lower($3))
     ORDER BY (user_id IS NOT NULL) DESC
     LIMIT 1`,
    [agreementId, userId, email],
  );
  return row ?? null;
}

/**
 * Resolve access for a user. Returns null when the agreement is invisible
 * (deleted, or neither an org reader nor a party), callers translate null
 * into 404 so hidden resources are indistinguishable from missing ones.
 */
export async function resolveAccess(
  db: Queryable,
  userId: string,
  email: string,
  agreementId: string,
): Promise<AgreementAccess | null> {
  const agreement = await loadAgreementRow(db, agreementId);
  if (!agreement) return null;

  const membership = await getMembership(db, userId, agreement.org_id);
  const party = await findPartyForUser(db, agreement.id, userId, email);

  const orgCanRead =
    membership !== null &&
    (READ_ROLES.includes(membership.role) ||
      // MEMBER may read only when they are a party on the agreement
      (membership.role === 'MEMBER' && party !== null));
  const partyCanRead = party !== null;

  if (!orgCanRead && !partyCanRead) return null;
  return { agreement, membership, party };
}

/** Throws 404 if not visible. */
export async function requireAccess(
  db: Queryable,
  userId: string,
  email: string,
  agreementId: string,
): Promise<AgreementAccess> {
  const access = await resolveAccess(db, userId, email, agreementId);
  if (!access) throw AppError.notFound('Agreement not found.');
  return access;
}

export function canManage(access: AgreementAccess): boolean {
  if (access.membership && MANAGE_ROLES.includes(access.membership.role)) return true;
  return access.party?.role === 'OWNER';
}

export function requireManage(access: AgreementAccess): void {
  if (!canManage(access)) {
    throw AppError.forbidden('You do not have permission to manage this agreement.');
  }
}

/**
 * Edit the working copy: org managers always; contributor/owner parties
 * during DRAFT/NEGOTIATION.
 */
export function requireEdit(access: AgreementAccess): void {
  const status = access.agreement.status;
  const preSign = status === 'DRAFT' || status === 'NEGOTIATION' || status === 'REVIEW';
  if (!preSign) {
    throw AppError.conflict(
      'AGREEMENT_NOT_EDITABLE',
      `Agreement is in status ${status} and can no longer be edited.`,
    );
  }
  if (canManage(access)) return;
  if (access.party && (access.party.role === 'CONTRIBUTOR' || access.party.role === 'OWNER')) return;
  throw AppError.forbidden('You do not have permission to edit this agreement.');
}

/** Approve requires being a linked party with an approver role. */
export function requireApprover(access: AgreementAccess): PartyRow {
  const party = access.party;
  if (!party || party.user_id === null || !APPROVER_ROLES.includes(party.role)) {
    throw AppError.forbidden('Only invited agreement parties can approve this version.');
  }
  return party;
}

/** Sign requires being a linked party whose signature is one of the required ones. */
export function requireSigner(access: AgreementAccess): PartyRow {
  const party = access.party;
  if (!party || party.user_id === null || !SIGNER_ROLES.includes(party.role)) {
    throw AppError.forbidden('Only required signing parties can sign this agreement.');
  }
  return party;
}

export function requireCommenter(access: AgreementAccess): void {
  // Anyone who can see the agreement can comment (matrix row "Comment").
  void access;
}
