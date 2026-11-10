/**
 * Response types for the AgreementHub API (mirrors apps/api route payloads).
 *
 * Note: the agreement *detail* endpoint returns sub-objects (parties, sections,
 * fields) as raw DB rows, snake_case, while top-level objects are camelCase.
 * Both are typed explicitly here so components never guess.
 */
import type { AgreementStatus, TransitionActor, VersionStatus } from '@agreementhub/domain';
import type {
  MissingRequiredField,
  RenderedTemplateSection,
  TemplateDefinition,
  TemplateFieldDef,
  TemplateFieldIssue,
  TemplateValue,
  TemplateValues,
} from '@agreementhub/domain/template';

export type { AgreementStatus, TransitionActor, VersionStatus };

export const USER_TYPES = [
  'INDIVIDUAL',
  'FREELANCER',
  'SMALL_BUSINESS',
  'PROFESSIONAL',
  'ORGANIZATION',
] as const;
export type UserType = (typeof USER_TYPES)[number];

export const PARTY_ROLES = ['OWNER', 'CONTRIBUTOR', 'REVIEWER', 'SIGNER', 'OBSERVER'] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/* ------------------------------- auth -------------------------------- */

export interface NotificationPreferences {
  reminders: boolean;
  comments: boolean;
  activity: boolean;
  email: boolean;
  obligationReminders?: boolean;
  /** Days relative to due date: positive = before, 0 = on due date, negative = after. */
  obligationReminderDays?: number[];
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  /** E.164 (e.g. +233241234567) when set. */
  phone: string | null;
  /** ISO 3166-1 alpha-2 country code (preferred). */
  countryCode?: string | null;
  /** Legacy/display field (mirrors countryCode when present). */
  country: string | null;
  /** Administrative region (e.g. a Ghana region). */
  region?: string | null;
  organizationName: string | null;
  userType: string | null;
  onboardingCompletedAt: string | null;
  isPlatformAdmin?: boolean;
  notificationPreferences?: NotificationPreferences;
  avatarUrl?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface SessionResponse {
  user: PublicUser;
  organizations: Organization[];
  requestId?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface ForgotPasswordResponse {
  ok: true;
  devResetToken?: string;
  devNotice?: string;
}

/* ----------------------------- agreements ---------------------------- */

export interface AgreementListItem {
  id: string;
  publicId: string;
  title: string;
  status: AgreementStatus;
  categoryCode: string;
  /** The caller's own party role on this agreement (null for org members without a party link). */
  myRole: PartyRole | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  finalizedAt: string | null;
}

export interface AgreementListResponse {
  agreements: AgreementListItem[];
  nextCursor: string | null;
}

export interface PartyDetail {
  id: string;
  user_id: string | null;
  email: string;
  display_name: string | null;
  avatarUrl: string | null;
  role: PartyRole;
  signing_order: number;
  status: string;
  added_at: string;
  signed_at: string | null;
}

export interface PartyPublic {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: PartyRole;
  signingOrder: number;
  status: string;
  linked: boolean;
  addedAt: string;
  signedAt: string | null;
}

export interface SectionRow {
  id: string;
  code: string;
  title: string;
  body: string;
  order_index: number;
  included: boolean;
}

export interface FieldRow {
  id: string;
  code: string;
  value: unknown;
  provenance: 'USER_PROVIDED' | 'AI_SUGGESTED_CONFIRMED' | 'COMPUTED';
  updated_at: string;
}

export interface VersionContent {
  agreementPublicId: string;
  title: string;
  templateCode: string;
  sections: Array<{ code: string; title: string; body: string; included: boolean }>;
  fields: Array<{ code: string; value: unknown; provenance: string }>;
  parties: Array<{ email: string; displayName: string; role: string; signingOrder: number }>;
}

export interface CurrentVersion {
  id: string;
  versionNumber: number;
  status: VersionStatus;
  changeSummary: string | null;
  documentHash: string;
  previousVersionId: string | null;
  createdAt: string;
  finalizedAt: string | null;
  content: VersionContent;
}

export interface AgreementSummary {
  id: string;
  publicId: string;
  title: string;
  status: AgreementStatus;
  orgId: string;
  templateId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  finalizedAt: string | null;
  closedReason: string | null;
  currentVersionId: string | null;
  finalVersionId: string | null;
}

export interface AgreementDetailResponse {
  agreement: AgreementSummary;
  category: { code: string; label: string } | null;
  /** Top-level convenience copy of agreement.templateId (template engine link). */
  templateId: string | null;
  templateName: string | null;
  parties: PartyDetail[];
  sections: SectionRow[];
  fields: FieldRow[];
  currentVersion: CurrentVersion | null;
}

/* ------------------------------ versions ----------------------------- */

export interface VersionListItem {
  id: string;
  versionNumber: number;
  status: VersionStatus;
  changeSummary: string | null;
  documentHash: string;
  previousVersionId: string | null;
  createdBy: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface VersionDiff {
  fromVersion: number;
  toVersion: number;
  hashFrom: string;
  hashTo: string;
  changes: Array<{
    kind: 'title' | 'section' | 'field' | 'party';
    code: string;
    change: 'added' | 'removed' | 'modified';
    from?: unknown;
    to?: unknown;
  }>;
}

/* --------------------------- negotiation ----------------------------- */

export type CommentStatus = 'OPEN' | 'RESOLVED';

export interface CommentItem {
  id: string;
  agreementId: string;
  versionId: string | null;
  sectionCode: string | null;
  parentId: string | null;
  authorType: string;
  authorLabel: string;
  body: string;
  status: CommentStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CommentListResponse {
  comments: CommentItem[];
}

export type ProposalKind = 'TITLE' | 'SECTION' | 'FIELD';
export type ProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface ChangeProposalItem {
  id: string;
  agreementId: string;
  versionId: string | null;
  kind: ProposalKind;
  targetCode: string;
  currentValue: unknown;
  proposedValue: unknown;
  note: string;
  status: ProposalStatus;
  proposedBy: string;
  proposedByLabel: string;
  decidedBy: string | null;
  decidedByLabel: string | null;
  decidedAt: string | null;
  decisionNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalListResponse {
  proposals: ChangeProposalItem[];
}

/** POST /agreements/:id/amendments, re-opens a sealed agreement. */
export interface AmendmentResult {
  agreement: AgreementSummary;
  version: {
    id: string;
    versionNumber: number;
    status: VersionStatus;
    changeSummary: string;
    documentHash: string;
    createdAt: string;
  };
  finalVersionNumber: number;
}

/* ------------------------------- templates --------------------------- */

export interface TemplateCategory {
  code: string;
  label: string;
  sort_order: number;
  template_count: number;
}

export interface TemplateListItem {
  id: string;
  name: string;
  description: string | null;
  template_version: string;
  signing_policy: 'PARALLEL' | 'SEQUENTIAL';
  required_approvals: number;
  category_code: string;
  category_label: string;
}

/* ---------------------------- template engine ----------------------- */
/**
 * Definition/evaluation shapes come from the shared engine in
 * @agreementhub/domain/template, the API and this UI evaluate templates
 * with the exact same code (conditions, validation, interpolation).
 */
export type {
  MissingRequiredField,
  RenderedTemplateSection,
  TemplateDefinition,
  TemplateFieldDef,
  TemplateFieldIssue,
  TemplateValue,
  TemplateValues,
};

export interface TemplateDetailResponse {
  template: {
    id: string;
    name: string;
    description: string | null;
    template_version: number;
    signing_policy: 'PARALLEL' | 'SEQUENTIAL';
    required_approvals: number;
    category_code: string;
    category_label: string;
    /** Raw template-engine definition (parse with parseTemplateDefinition). */
    content_schema: unknown;
  };
}

/** Response of the preview/generate template-engine endpoints. */
export interface TemplateEvaluationResponse {
  templateId: string | null;
  templateName: string | null;
  values: TemplateValues;
  /** Visible fields (after conditions). */
  fields: TemplateFieldDef[];
  /** Visible required fields still blank, blocks signing/finalization. */
  missingRequired: MissingRequiredField[];
  /** Per-field validation issues (required blanks + format errors). */
  issues: TemplateFieldIssue[];
  /** Composed sections in document order (with visibility flags). */
  sections: RenderedTemplateSection[];
  /** Present and true on the generate endpoint after persistence. */
  persisted?: boolean;
}

/* ------------------------------- approvals --------------------------- */

export interface ApprovalResult {
  approval: { id: string; decision: string; decidedAt: string };
  policySatisfied: boolean;
  versionStatus: string;
}

/* ------------------------------ signatures --------------------------- */

export type ObligationStatus = 'UPCOMING' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED' | 'CANCELLED';

export interface ObligationOverviewItem extends Obligation {
  agreementPublicId: string;
  agreementTitle: string;
  agreementStatus: string;
  assignedToMe: boolean;
  needsReview: boolean;
  governingVersionNumber: number | null;
  currentVersionNumber: number | null;
}

export interface Obligation {
  id: string;
  agreementId: string;
  versionId: string | null;
  responsiblePartyId: string | null;
  responsibleLabel: string | null;
  responsibleName: string | null;
  responsibleEmail: string | null;
  title: string;
  description: string | null;
  dueAt: string;
  status: ObligationStatus;
  notes: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignResult {
  signature: {
    id: string;
    versionId: string;
    signedAt: string;
    method: string;
    documentHashAtSigning: string;
    signaturePayloadHash: string;
    consentTextVersion: string;
  };
  allSigned: boolean;
  missingSignatures: number;
}

export interface SignatureItem {
  id: string;
  versionId: string;
  signerEmail: string;
  partyRole: PartyRole;
  method: string;
  signedAt: string;
  documentHashAtSigning: string;
  consentTextVersion: string;
}

export interface SignatureStatus {
  status: AgreementStatus;
  required: number;
  signed: number;
}

export interface SignatureListResponse {
  status: string;
  signatures: SignatureItem[];
}

export interface FinalizeResult {
  finalized: true;
  agreementId: string;
  publicId: string;
  versionId: string;
  documentHash: string;
  verificationUrl: string;
  /** SHA-256 of the immutable final PDF (null when PDF generation is off). */
  pdfSha256?: string | null;
}

/* -------------------------------- audit ------------------------------ */

export interface AuditEvent {
  seq: number | null;
  eventType: string;
  /** USER | AGREEMENT | SYSTEM, how the event is classified in the trail. */
  category: string;
  actorType: string;
  actorLabel: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
  occurredAt: string;
  eventHash: string;
}

/* ----------------------------- notifications ------------------------- */

export interface NotificationItem {
  id: string;
  type: string;
  agreementId: string | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResponse {
  notifications: NotificationItem[];
  counts: { total: number; unread: number };
}

/* ------------------------------ dashboard ---------------------------- */

export type PendingActionType = 'SIGN' | 'APPROVE' | 'REVIEW';

export interface DashboardResponse {
  counts: {
    total: number;
    drafts: number;
    awaitingAction: number;
    active: number;
    expiring: number;
    expired: number;
    awaitingSignatures: number;
    closed: number;
  };
  pendingActions: Array<{
    agreementId: string;
    publicId: string;
    title: string;
    status: AgreementStatus;
    action: PendingActionType;
    updatedAt: string;
  }>;
  recentActivity: Array<{
    agreementId: string;
    publicId: string;
    title: string;
    eventType: string;
    actorLabel: string;
    occurredAt: string;
  }>;
}

/* ----------------------------- verification -------------------------- */

export type VerificationRecordState = 'VALID' | 'MODIFIED' | 'REVOKED' | 'UNAVAILABLE';

export interface VerificationResponse {
  agreementId: string | null;
  found: boolean;
  status: AgreementStatus | string | null;
  /** Primary record state: valid/intact, modified/tampered, revoked/lifecycle-ended, unavailable. */
  recordState?: VerificationRecordState;
  lifecycleLabel?: string | null;
  recordMessage?: string | null;
  /** Template category label (safe metadata). */
  category?: string | null;
  version: number | null;
  createdAt: string | null;
  finalizedAt: string | null;
  integrity: 'VERIFIED' | 'MISMATCH' | 'NOT_FOUND';
  contentIntegrity: 'VERIFIED' | 'MISMATCH' | 'NOT_AVAILABLE';
  pdfIntegrity: 'VERIFIED' | 'MISMATCH' | 'NOT_AVAILABLE';
  signatureIntegrity: 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED' | 'NOT_AVAILABLE';
  signatures: { total: number; verified: number };
  hashPrefix: string | null;
  pdfHash: string | null;
  pdfHashPrefix: string | null;
  disclaimer?: string;
}

/* -------------------------- platform administration ------------------ */

export interface AdminStats {
  users: number;
  verifiedUsers: number;
  suspendedUsers: number;
  agreements: number;
  agreementsByStatus: Array<{ status: string; count: number }>;
  publishedTemplates: number;
  draftTemplates: number;
  categories: number;
  outboxPending: number;
  outboxFailed: number;
  unreadNotifications: number;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerifiedAt: string | null;
  isPlatformAdmin: boolean;
  organizations: number;
  createdAt: string;
}

export interface AdminCategory {
  id: string;
  code: string;
  label: string;
  sortOrder: number;
  isEnabled: boolean;
  templateCount?: number;
  createdAt: string;
}

export interface AdminTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  signingPolicy: string;
  requiredApprovals: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  categoryId: string;
  categoryCode: string;
  categoryLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTemplateVersion {
  id: string;
  name: string;
  description: string;
  version: number;
  signingPolicy: string;
  requiredApprovals: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  contentSchema: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AdminActivity {
  adminActions: Array<{
    id: string;
    actorLabel: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  systemActivity: Array<{
    eventType: string;
    actorType: string;
    actorLabel: string;
    publicId: string | null;
    occurredAt: string;
  }>;
}

/* ----------------------------- AI assistant -------------------------- */
/**
 * Shapes come straight from @agreementhub/contracts (the API validates its
 * responses with the same zod schemas), so UI and API can never drift.
 */
export type {
  AiExtractResponse,
  AiExtractedField,
  AiExplainResponse,
  AiQuestionsResponse,
  AiQuestion,
  AiReviewResponse,
  AiReviewItem,
  AiSummaryResponse,
} from '@agreementhub/contracts';
