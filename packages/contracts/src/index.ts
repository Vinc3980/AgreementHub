import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const uuidSchema = z.string().uuid();

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const publicIdSchema = z
  .string()
  .regex(/^[A-Z]{2,4}-[A-Z]{2,4}-\d{4}-\d{6}$/, 'Malformed Agreement ID');

export const changeSummarySchema = z.string().trim().min(3).max(500);
export const reasonSchema = z.string().trim().min(3).max(1000);

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), {
    message: 'Password must contain letters and numbers',
  });

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(120),
  organizationName: z.string().trim().min(1).max(120).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userResponseSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  emailVerifiedAt: z.string().nullable().optional(),
  isPlatformAdmin: z.boolean().optional(),
  /** Authenticated avatar route; null when no picture is set. */
  avatarUrl: z.string().nullable().optional(),
});
export type UserResponse = z.infer<typeof userResponseSchema>;

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(10).max(200),
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/* ------------------------------------------------------------------ */
/* Notification preferences                                            */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_CATEGORIES = ['reminders', 'comments', 'activity'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Per-user notification switches. Security/action-required notifications
 * (invitations, approval/signature requests) are deliberately not toggleable.
 */
export const notificationPreferencesSchema = z.object({
  reminders: z.boolean().optional(),
  comments: z.boolean().optional(),
  activity: z.boolean().optional(),
  email: z.boolean().optional(),
  obligationReminders: z.boolean().optional(),
  obligationReminderDays: z.array(z.number().int()).optional(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/* ------------------------------------------------------------------ */
/* Agreements                                                          */
/* ------------------------------------------------------------------ */

export const createAgreementRequestSchema = z.object({
  orgId: uuidSchema.optional(),
  templateId: uuidSchema,
  title: z.string().trim().min(1).max(300),
  /** Plain-language intention (optional; AI assistance consumes this later). */
  brief: z.string().trim().max(10000).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateAgreementRequest = z.infer<typeof createAgreementRequestSchema>;

export const agreementFieldInputSchema = z.object({
  code: z.string().trim().min(1).max(100),
  value: z.unknown(),
  provenance: z
    .enum(['USER_PROVIDED', 'AI_SUGGESTED_CONFIRMED', 'COMPUTED'])
    .default('USER_PROVIDED'),
});

export const agreementSectionInputSchema = z.object({
  code: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(100000).default(''),
  included: z.boolean().default(true),
});

export const updateDraftRequestSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  sections: z.array(agreementSectionInputSchema).max(200).optional(),
  fields: z.array(agreementFieldInputSchema).max(500).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type UpdateDraftRequest = z.infer<typeof updateDraftRequestSchema>;

export const createVersionRequestSchema = z.object({
  changeSummary: changeSummarySchema,
});
export type CreateVersionRequest = z.infer<typeof createVersionRequestSchema>;

export const transitionRequestSchema = z.object({
  to: z.enum([
    'REVIEW',
    'NEGOTIATION',
    'AWAITING_SIGNATURES',
    'ACTIVE',
    'EXPIRING',
    'EXPIRED',
    'DRAFT',
    'CANCELLED',
    'TERMINATED',
    'REJECTED',
  ]),
  reason: reasonSchema.optional(),
});
export type TransitionRequest = z.infer<typeof transitionRequestSchema>;

/* ------------------------------------------------------------------ */
/* Parties & invitations                                               */
/* ------------------------------------------------------------------ */

export const partyRoleSchema = z.enum(['OWNER', 'CONTRIBUTOR', 'REVIEWER', 'SIGNER', 'OBSERVER']);
export type PartyRole = z.infer<typeof partyRoleSchema>;

/** Party payload shared by the list, invite, and agreement-detail responses. */
export const partyResponseSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string().nullable().optional(),
  /** Authenticated avatar route; null for unlinked invitees and no picture. */
  avatarUrl: z.string().nullable().optional(),
  role: partyRoleSchema,
  signingOrder: z.number().int(),
  status: z.string(),
  linked: z.boolean().optional(),
  addedAt: z.string().optional(),
  signedAt: z.string().nullable().optional(),
});
export type PartyResponse = z.infer<typeof partyResponseSchema>;

export const invitePartyRequestSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(120).optional(),
  role: partyRoleSchema.default('SIGNER'),
  signingOrder: z.number().int().min(0).max(99).default(0),
});
export type InvitePartyRequest = z.infer<typeof invitePartyRequestSchema>;

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(10).max(200),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

export const addCommentRequestSchema = z.object({
  agreementId: uuidSchema,
  /** Version the comment is attached to (negotiation context). Defaults to current. */
  versionId: uuidSchema.optional(),
  sectionCode: z.string().trim().min(1).max(100).optional(),
  body: z.string().trim().min(1).max(10000),
});
export type AddCommentRequest = z.infer<typeof addCommentRequestSchema>;

export const commentStatusSchema = z.enum(['OPEN', 'RESOLVED']);
export type CommentStatus = z.infer<typeof commentStatusSchema>;

export const updateCommentRequestSchema = z.object({
  status: commentStatusSchema,
});
export type UpdateCommentRequest = z.infer<typeof updateCommentRequestSchema>;

/* ------------------------------------------------------------------ */
/* Change proposals (negotiation suggestions)                          */
/* ------------------------------------------------------------------ */

/**
 * A suggestion never edits the agreement by itself: a user with edit rights
 * must explicitly accept it (which then runs through the normal draft-update
 * path and, during negotiation, creates a new version).
 */
export const proposalKindSchema = z.enum(['TITLE', 'SECTION', 'FIELD']);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

export const proposalStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REJECTED']);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const createProposalRequestSchema = z.object({
  agreementId: uuidSchema,
  /** Version the suggestion was drafted against (snapshot). Defaults to current. */
  versionId: uuidSchema.optional(),
  kind: proposalKindSchema,
  /** 'title' for TITLE, a section code for SECTION, a field code for FIELD. */
  targetCode: z.string().trim().min(1).max(100),
  proposedValue: z.unknown(),
  note: z.string().trim().max(2000).optional(),
});
export type CreateProposalRequest = z.infer<typeof createProposalRequestSchema>;

export const decideProposalRequestSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  note: z.string().trim().max(2000).optional(),
});
export type DecideProposalRequest = z.infer<typeof decideProposalRequestSchema>;

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export const requestApprovalRequestSchema = z.object({
  agreementId: uuidSchema,
  versionId: uuidSchema.optional(),
  partyIds: z.array(uuidSchema).min(1).max(50).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type RequestApprovalRequest = z.infer<typeof requestApprovalRequestSchema>;

export const recordApprovalRequestSchema = z.object({
  agreementId: uuidSchema,
  decision: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().trim().max(2000).optional(),
});
export type RecordApprovalRequest = z.infer<typeof recordApprovalRequestSchema>;

/* ------------------------------------------------------------------ */
/* Signatures                                                          */
/* ------------------------------------------------------------------ */

export const requestSignatureRequestSchema = z.object({
  agreementId: uuidSchema,
  versionId: uuidSchema.optional(),
  partyIds: z.array(uuidSchema).min(1).max(50).optional(),
  message: z.string().trim().max(2000).optional(),
});
export type RequestSignatureRequest = z.infer<typeof requestSignatureRequestSchema>;

/**
 * MVP signing methods: typed name, drawn signature, explicit electronic
 * acceptance. SESSION/EMAIL_OTP are kept for API clients that sign from an
 * authenticated session or an emailed one-time link.
 */
export const signingMethodSchema = z.enum([
  'TYPED',
  'DRAWN',
  'CONSENT',
  'SESSION',
  'EMAIL_OTP',
]);
export type SigningMethod = z.infer<typeof signingMethodSchema>;

export const recordSignatureRequestSchema = z
  .object({
    agreementId: uuidSchema,
    /** Explicit signing intent text displayed on the public record. */
    consent: z.literal(true, {
      errorMap: () => ({ message: 'Explicit consent is required to sign.' }),
    }),
    /** Typed name (TYPED) or free-form signing text. */
    signatureText: z.string().trim().min(1).max(200).optional(),
    /** Drawn signature as an image data URL (DRAWN), e.g. canvas.toDataURL(). */
    signatureData: z
      .string()
      .max(200_000)
      .regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/, {
        message: 'signatureData must be a base64 image data URL (png, jpeg or svg).',
      })
      .optional(),
    method: signingMethodSchema.default('SESSION'),
    /** Six-digit code emailed to the signer (required for EMAIL_OTP). */
    otpCode: z
      .string()
      .regex(/^\d{6}$/, 'The signing code must be six digits')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.method === 'TYPED' && !value.signatureText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signatureText'],
        message: 'Type your name to sign with this method.',
      });
    }
    if (value.method === 'DRAWN' && !value.signatureData) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signatureData'],
        message: 'Draw your signature before signing with this method.',
      });
    }
    if (value.method === 'EMAIL_OTP' && !value.otpCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['otpCode'],
        message: 'Request and enter the emailed signing code to sign with this method.',
      });
    }
    if (value.method !== 'EMAIL_OTP' && value.otpCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['otpCode'],
        message: 'A signing code can only be used with the EMAIL_OTP method.',
      });
    }
  });
export type RecordSignatureRequest = z.infer<typeof recordSignatureRequestSchema>;

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export const verifyRequestSchema = z.object({
  agreementId: publicIdSchema,
  /** Optional full hash; when supplied it must match the sealed document hash. */
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'Hash must be a 64-char lowercase hex SHA-256')
    .optional(),
  /** Optional full PDF-byte hash; detects a tampered/replaced final document. */
  pdfHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'pdfHash must be a 64-char lowercase hex SHA-256')
    .optional(),
});
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

/* ------------------------------------------------------------------ */
/* Account profile (onboarding) & password reset                       */
/* ------------------------------------------------------------------ */

export const userTypeSchema = z.enum([
  'INDIVIDUAL',
  'FREELANCER',
  'SMALL_BUSINESS',
  'PROFESSIONAL',
  'ORGANIZATION',
]);
export type UserType = z.infer<typeof userTypeSchema>;

export const updateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  /** Phone in any accepted form; server normalizes to E.164 (defaults to +233/Ghana). */
  phone: z.string().trim().max(40).optional(),
  /** ISO 3166-1 alpha-2 country code (e.g. GH). Replaces legacy free-text `country`. */
  countryCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'Country code must be a 2-letter ISO code'))
    .optional(),
  /** Administrative region (e.g. one of Ghana's 16 regions when country is GH). */
  region: z.string().trim().max(80).optional(),
  /** Legacy free-text country, accepted for compatibility and ignored by the server. */
  country: z.string().trim().min(2).max(64).optional(),
  organizationName: z.string().trim().max(120).optional(),
  userType: userTypeSchema.optional(),
  /** Marks onboarding as finished (used by the onboarding wizard). */
  completeOnboarding: z.boolean().optional(),
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/* ------------------------------------------------------------------ */
/* Shared list params                                                  */
/* ------------------------------------------------------------------ */

export const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const agreementListQuerySchema = listQuerySchema.extend({
  status: z
    .enum([
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
    ])
    .optional(),
  category: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  orgId: uuidSchema.optional(),
  /** Filter by created_at lower bound (inclusive). */
  dateFrom: z.string().datetime({ offset: true }).optional(),
  /** Filter by created_at upper bound (inclusive). */
  dateTo: z.string().datetime({ offset: true }).optional(),
  /** Filter by the caller's party role on the agreement. */
  role: partyRoleSchema.optional(),
});
export type AgreementListQuery = z.infer<typeof agreementListQuerySchema>;

/* ------------------------------------------------------------------ */
/* Template engine (data-driven definitions)                          */
/* ------------------------------------------------------------------ */

export const templateFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'money',
  'date',
  'email',
  'select',
  'toggle',
]);

export const templateShowIfSchema = z.object({
  /** Code of another field in the same definition. */
  field: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Invalid field code'),
  equals: z.union([z.string().max(200), z.number(), z.boolean()]),
});

export const templateFieldSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Invalid field code'),
  label: z.string().trim().min(1).max(200),
  type: templateFieldTypeSchema,
  /** Required visible fields block approval/signing/finalization when blank. */
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(120)).max(50).optional(),
  /** Author guidance shown in forms; never part of the document body. */
  guidance: z.string().max(600).optional(),
  placeholder: z.string().max(200).optional(),
  /** Form group heading; fields keep definition order within a group. */
  group: z.string().max(100).optional(),
  default: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  showIf: templateShowIfSchema.optional(),
  /** Optional format constraint (e.g. Ghana phone, Ghana Post GPS digital address). */
  format: z.enum(['ghana_phone', 'ghana_post_gps']).optional(),
});

export const templateSectionSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Invalid section code'),
  title: z.string().trim().min(1).max(300),
  order: z.number().int().min(0).max(999).default(0),
  required: z.boolean().default(false),
  guidance: z.string().max(600).optional(),
  showIf: templateShowIfSchema.optional(),
  /** Template text with {{field:CODE}} placeholders; plain text (not HTML). */
  body: z.string().max(100000).optional(),
});

export const templateDefinitionSchema = z.object({
  definitionVersion: z.number().int().min(1).max(999).default(1),
  sections: z.array(templateSectionSchema).min(1).max(100),
  fields: z.array(templateFieldSchema).min(1).max(300),
});
export type TemplateDefinitionInput = z.infer<typeof templateDefinitionSchema>;

/** Field values accepted by template preview/generate. */
export const templateValuesSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]),
);
export type TemplateValues = z.infer<typeof templateValuesSchema>;

export const templatePreviewRequestSchema = z.object({
  /** Optional overlay of unsaved values for live previewing. */
  values: templateValuesSchema.optional(),
});
export type TemplatePreviewRequest = z.infer<typeof templatePreviewRequestSchema>;

export const templateGenerateRequestSchema = z.object({
  /** Optional values persisted atomically together with generation. */
  values: templateValuesSchema.optional(),
});
export type TemplateGenerateRequest = z.infer<typeof templateGenerateRequestSchema>;

/* ------------------------ AI assistant contracts ------------------------- */
export * from './ai.js';

/* ------------------------------------------------------------------ */
/* Administrator                                                       */
/* ------------------------------------------------------------------ */

export const adminUpdateUserRequestSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    isPlatformAdmin: z.boolean().optional(),
  })
  .refine((v) => v.status !== undefined || v.isPlatformAdmin !== undefined, {
    message: 'Provide at least one field to update.',
  });
export type AdminUpdateUserRequest = z.infer<typeof adminUpdateUserRequestSchema>;

export const adminCategoryCreateRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/, 'Category code must be lowercase letters, digits or dashes'),
  label: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type AdminCategoryCreateRequest = z.infer<typeof adminCategoryCreateRequestSchema>;

export const adminCategoryUpdateRequestSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isEnabled: z.boolean().optional(),
});
export type AdminCategoryUpdateRequest = z.infer<typeof adminCategoryUpdateRequestSchema>;

export const adminTemplateCreateRequestSchema = z.object({
  categoryId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  definition: templateDefinitionSchema,
  signingPolicy: z.enum(['PARALLEL', 'SEQUENTIAL']).default('PARALLEL'),
  requiredApprovals: z.number().int().min(0).max(20).default(1),
});
export type AdminTemplateCreateRequest = z.infer<typeof adminTemplateCreateRequestSchema>;

export const adminTemplateUpdateRequestSchema = z
  .object({
    description: z.string().trim().max(2000).optional(),
    signingPolicy: z.enum(['PARALLEL', 'SEQUENTIAL']).optional(),
    requiredApprovals: z.number().int().min(0).max(20).optional(),
  })
  .refine(
    (v) =>
      v.description !== undefined ||
      v.signingPolicy !== undefined ||
      v.requiredApprovals !== undefined,
    { message: 'Provide at least one field to update.' },
  );
export type AdminTemplateUpdateRequest = z.infer<typeof adminTemplateUpdateRequestSchema>;

/** A new template version is a NEW row, published history is never mutated. */
export const adminTemplateVersionRequestSchema = z.object({
  definition: templateDefinitionSchema,
  description: z.string().trim().max(2000).optional(),
});
export type AdminTemplateVersionRequest = z.infer<typeof adminTemplateVersionRequestSchema>;

