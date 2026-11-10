# AgreementHub: Pre-Implementation Specification

**Version:** 1.0
**Status:** Approved for architecture & planning phase
**Scope:** This document is the authoritative specification for AgreementHub prior to writing application code. It covers functional/non-functional requirements, roles, journeys, architecture, data model, API design, security, AI, notifications, milestones, and the final implementation blueprint.

---

## 0. Product Positioning & Boundaries

### 0.1 What AgreementHub is
A secure digital agreement platform for individuals, freelancers, professionals, and small businesses. It supports the full agreement lifecycle: intention → structured document → AI assistance → review → negotiation → versioned finalization → electronic acceptance/signature → audit trail → verification → storage → expiry/renewal.

### 0.2 What AgreementHub explicitly is NOT
- **Not a law firm.** It does not provide legal advice, legal opinions, or attorney-client relationships.
- **Not a government registry.** Electronic signature and verification here are contract-management features, not government registration or notarization.
- **Not a replacement for professional counsel.** Users are advised to seek independent legal advice for consequential agreements.

### 0.3 Excluded document types (v1 hard block)
The template registry must refuse to enable templates in these categories, enforced at the domain level (`ExcludedCategoryGuard`), not merely by convention:

| Excluded | Reason |
|---|---|
| Land ownership / title transfer | Registration regimes, statutory formalities |
| Wills / testaments | Formal witnessing requirements |
| Powers of attorney | Statutory form requirements |
| Court & legal filings | Jurisdiction-controlled |
| Complex regulated financial contracts | Regulatory compliance (securities, banking, insurance) |
| Documents requiring government registration | Outside system capability |

Excluded requests are answered with a clear message: *"AgreementHub does not support this document type. This platform does not provide legal advice."*

### 0.4 Capability language discipline
The product must use precise, separated vocabulary. Each term has a distinct UI label, a distinct audit-event family, and a distinct disclaimer:

| Term | Meaning in AgreementHub |
|---|---|
| **Document generation** | Rendering structured agreement data into a professional PDF/document. |
| **Electronic acceptance** | A party explicitly acknowledges/agrees to a version (approval), without a signature mark. |
| **Electronic signature** | A party cryptographically binds their identity to a finalized version (signature record + hash). |
| **Document verification** | Checking a finalized document's hash against the stored integrity record. Proves *integrity*, not *validity of the contract*. |
| **Legal advice** | **Not offered.** AI output and templates are informational only. |

**Standing disclaimer (rendered in AI panels, footer, finalization flow, and printed documents):**
> AgreementHub is not a law firm and does not provide legal advice. Templates and AI output are informational tools. Electronic acceptance and electronic signature records capture intent and document integrity; they do not certify legal validity in any jurisdiction. For consequential agreements, consult a qualified professional.

---

## 1. Functional Requirements

### FR-1 Accounts, organizations & membership
- FR-1.1 Users register with email + password (verified) and/or social/OIDC login.
- FR-1.2 Users belong to one or more **Organizations** (workspaces) with per-org roles.
- FR-1.3 A personal "Home" organization is auto-created at signup.
- FR-1.4 Organization owners can invite members by email with a role assignment.
- FR-1.5 Users can switch organizations; all agreement data is org-scoped.
- FR-1.6 Members can be suspended/removed; ownership transfer supported.

### FR-2 Template architecture
- FR-2.1 Templates are **data-driven** (category → template → sections → fields), stored in DB and versioned. No template requires code changes.
- FR-2.2 Five initial categories: **Freelance/Service Agreement**, **Rental Agreement**, **Business Proposal**, **Non-Disclosure Agreement**, **Client/User Agreement**.
- FR-2.3 Each category has 1+ templates; each template defines sections, fields, field types, validation rules, conditional visibility, and rendering order.
- FR-2.4 **New categories can be added via registry records** (category, icon, i18n label, allowed field types) without application rewrites.
- FR-2.5 Template schema supports `required`, `optional`, `ai-suggested` (must be confirmed), and `computed` field kinds.
- FR-2.6 Excluded categories are rejected by the domain guard (§0.3).
- FR-2.7 Templates are versioned; agreements pin the template version used so historical documents remain reproducible.

### FR-3 Agreement creation (structured, not free-form)
- FR-3.1 Creation flow: choose category → choose template → provide intention (plain-language brief, optional) → complete structured fields → preview document.
- FR-3.2 Every field value is stored as an **AgreementField** record with provenance metadata (`USER_PROVIDED` | `AI_SUGGESTED_CONFIRMED` | `COMPUTED`).
- FR-3.3 Draft autosave; drafts are editable and do not generate versions until a substantive change is made post-first-version.
- FR-3.4 Attachments (files) supported per agreement with scanning/quarantine.

### FR-4 Agreement ID
- FR-4.1 Every agreement gets a public, human-readable ID: `AGR-<ISO>-<YYYY>-<NNNNNN>` (e.g., `AGR-GH-2026-000001`). Country/region segment configurable per deployment/organization.
- FR-4.2 **Internally the primary key is UUIDv7.** The public ID is a separate indexed column with a unique constraint.
- FR-4.3 Sequence numbers are allocated from a **per-year counter table with row locking** (not global sequential PK), making enumeration non-informative and IDs non-reusable.
- FR-4.4 The Agreement ID appears on the document, verification page, QR code, and all notifications. It never changes, across all versions.

### FR-5 Agreement lifecycle (status machine)
- FR-5.1 States: `DRAFT → REVIEW → NEGOTIATION → AWAITING_SIGNATURES → ACTIVE → EXPIRING → EXPIRED`, plus terminal `CANCELLED`, `TERMINATED`, `REJECTED`.
- FR-5.2 All transitions occur through a single domain service (`AgreementLifecycleService`) that validates the transition matrix, records an audit event, and enforces permission checks.
- FR-5.3 Expiry is time-driven: a scheduler moves `ACTIVE → EXPIRING` (configurable lead time, default 30 days) then `→ EXPIRED`.
- FR-5.4 `ACTIVE → TERMINATED` requires a reason + audit event; `AWAITING_SIGNATURES → CANCELLED/REJECTED` likewise.
- FR-5.5 Illegal transitions return a typed domain error (`INVALID_TRANSITION`), never silently ignored.

### FR-6 Parties, invitations & review
- FR-6.1 An agreement has 1..n **AgreementParty** records (internal member or external contact with email).
- FR-6.2 External parties are invited via signed, expiring invitation links (token hash stored, never the raw token).
- FR-6.3 External parties access a **scoped guest session**: they can view the assigned version, comment, approve, sign, nothing else (no org browsing, no other agreements).
- FR-6.4 Party view events are recorded (`PARTY_VIEWED` audit event) for the audit trail.
- FR-6.5 Roles per party: `OWNER`, `CONTRIBUTOR`, `REVIEWER`, `SIGNER`, `OBSERVER`.

### FR-7 Review, comments & negotiation
- FR-7.1 Review state: parties can comment at agreement level or **per-section** (`Comment` entity with thread/reply).
- FR-7.2 Negotiation is expressed through versioned revisions: a reviewer proposes changes (or a contributor edits) → creates a new version → counterpart reviews/approves/rejects.
- FR-7.3 Comments are attached to a specific version, so negotiation context survives version bumps.
- FR-7.4 Approvals are recorded per party per version (`Approval` entity). A version becomes signable when approval policy is satisfied (all required parties, or majority, configurable).

### FR-8 Version control
- FR-8.1 Every **substantive** modification creates a new immutable `AgreementVersion`. Cosmetic edits (metadata, title typo policy) are configurable but default to versioning.
- FR-8.2 Versions store: sequential `version_number` (int), `creator_id`, `created_at`, full content snapshot (JSON of sections/fields), `document_hash` (SHA-256 of canonicalized content), `previous_version_id`, `change_summary`, `status` (`DRAFT | SUPERSEDED | PENDING_APPROVAL | APPROVED | FINAL | REJECTED`).
- FR-8.3 Versions are **append-only**: the app DB user has no UPDATE/DELETE grant on the versions table (enforced via DB permissions + append-only repository pattern).
- FR-8.4 Signed/finalized versions are locked forever: any subsequent edit starts a new draft version derived from the final one; the final version hash never changes.
- FR-8.5 Version diff view (field-level and section-level) between any two versions.
- FR-8.6 One version can be marked `FINAL` per agreement finalization event (re-finalization creates a new version + new finalization record, never overwriting).

### FR-9 AI assistance (assistive, never authoritative)
- FR-9.1 **Intention extraction:** plain-language brief → structured field suggestions (never auto-committed).
- FR-9.2 **Field suggestions:** shown in an "AI suggested" affordance with one-click *Accept* / *Reject*; accepted values are stored with provenance `AI_SUGGESTED_CONFIRMED` and attributed in the UI.
- FR-9.3 **Clause explanation:** select a section → plain-language explanation + "what to consider" checklist.
- FR-9.4 **Missing-section detection:** compares the agreement's sections against the template baseline and category knowledge set → list of "potentially missing sections", each with rationale.
- FR-9.5 **Question generation:** "questions you should answer before finalizing."
- FR-9.6 **Summarization:** short/medium summaries of any version.
- FR-9.7 **Hard AI constraints (enforced at prompt + output validation layer):**
  - The model must receive only template metadata + user-provided values; it must not be asked to invent names, prices, dates, addresses, obligations, signatures, or legal facts.
  - Output schema is structured JSON validated against a strict schema; any field marked as a factual assertion must carry a `source` of `USER_INPUT` or `TEMPLATE_BASELINE`.
  - Outputs failing schema/provenance validation are discarded and retried once, then surfaced as "AI unavailable" rather than shown unchecked.
  - Every AI panel shows provenance chips: **USER-PROVIDED** vs **AI-SUGGESTED**, plus the standing disclaimer.
  - AI never writes to agreement content directly; only user acceptance does.
- FR-9.8 AI usage is audited (`AI_ASSISTED` audit event with feature name, model, token counts) but AI prompt/response bodies are stored separately from the agreement record (privacy boundary), retained per policy.

### FR-10 Electronic acceptance & signature
- FR-10.1 A party can **approve** (electronic acceptance) a specific version, recorded with identity, timestamp, version hash, and IP/user-agent metadata.
- FR-10.2 A party can **sign**: signature record captures `signer identity (user or invited external verified-email)`, `method` (`EMAIL_OTP` | `AUTHENTICATED_SESSION` | `DRAWN_SIGNATURE_IMAGE` optional), `signed_at`, `version_id`, `document_hash_at_signing`, `signature_payload_hash`, device/IP metadata.
- FR-10.3 Signature binds cryptographically: `signature_payload_hash = SHA-256(agreement_id ‖ version_id ‖ document_hash ‖ signer_id ‖ timestamp ‖ nonce)`; payload stored for later independent verification.
- FR-10.4 Signing order (sequential vs parallel) configurable per template; enforced by the signature orchestration service.
- FR-10.5 When all required signatures are collected → status `AWAITING_SIGNATURES → ACTIVE` (or straight to `ACTIVE` on finalization) and **finalization** occurs: final version status `FINAL`, hash sealed, Agreement ID + QR generated.
- FR-10.6 Signed documents are immutable; download always re-renders from the sealed version and the rendered artifact hash is recorded (`DOCUMENT_DOWNLOADED` audit event).

### FR-11 Audit trail
- FR-11.1 Every meaningful action creates an `AuditEvent` (§12).
- FR-11.2 Audit events are append-only, tamper-evident (hash-chained per agreement), and queryable per agreement in a chronological timeline UI.
- FR-11.3 Timeline shows actor (or "external guest: email"), action, timestamp (UTC + user TZ display), and human-readable detail.
- FR-11.4 Audit events are retained for the life of the agreement + configured retention period; deletion requests anonymize actor references rather than deleting events (unless legally required).

### FR-12 Verification & QR
- FR-12.1 Finalization generates a **verification record**: Agreement ID, version, finalization timestamp, document hash, verification status.
- FR-12.2 A **QR code** encodes a public URL: `/verify/{agreementId}` (short, non-guessable path variant supported).
- FR-12.3 **Public verification page** exposes only: Agreement ID, Status, Version, Creation date, Finalization date, Integrity status (`VERIFIED` / `MISMATCH` / `NOT_FOUND`), template category name. **Never** clause contents, party names, comments, or any confidential data. Rate-limited and cached.
- FR-12.4 Verification recomputes/compares the stored hash; each check writes a `VerificationRecord` + `DOCUMENT_VERIFIED` audit event.
- FR-12.5 Verification also works offline: the printed footer carries Agreement ID + short hash so a human can confirm against the public page.
- FR-12.6 Public endpoint is unauthenticated, bot-protected (rate limit + proof-of-work/challenge if abused), and logs all accesses.

### FR-13 Document generation & download
- FR-13.1 Deterministic rendering: structured version → styled HTML → PDF (server-side), plus `.docx` export optional later.
- FR-13.1b The rendered PDF includes: header with Agreement ID + version, body sections in template order, signature block with signer timestamps, footer with hash prefix + verification URL + disclaimer.
- FR-13.2 Print stylesheet for browser print of on-screen documents.
- FR-13.3 Rendered artifacts for finalized versions are stored (immutable object storage) with their SHA-256 recorded; re-renders must reproduce identical hash or be flagged.

### FR-14 Management, reminders & notifications
- FR-14.1 Agreement list views: Active, Pending (review/negotiation/awaiting signatures), Expired, Terminated/Cancelled/Rejected, All. Filter/sort/search by ID, title, category, party, date.
- FR-14.2 Reminder rules (§16): pending signature reminders (e.g., 3 days after request, then every 3 days up to cap), expiry approach reminders (30/7/1 days before), invitation expiry, comment replies, approvals requested, status changes.
- FR-14.3 In-app notification center + email; user-level preference per notification type (some, e.g. security events, non-disableable).
- FR-14.4 Digest option for low-priority notifications.

### FR-15 Access, export & deletion
- FR-15.1 Users can export their agreement data (JSON + PDFs), portability.
- FR-15.2 Account deletion flow with legal-hold checks: finalized agreements and audit trails are retained per policy with actor anonymization (documented in privacy policy).
- FR-15.3 Session management: list active sessions, revoke.

---

## 2. Non-Functional Requirements

### NFR-1 Security
- Passwords hashed with Argon2id (or bcrypt ≥12 as fallback); email verification required before agreement actions.
- MFA (TOTP) supported, required optionally per org policy.
- All secrets in environment/secret manager; never in repo.
- OWASP ASVS L2 target; protection against injection, XSS (CSP + output encoding), CSRF (double-submit + SameSite), SSRF, IDOR (org scoping enforced at repository layer), file-upload attacks (type sniffing, size limits, AV quarantine).
- Rate limiting on auth, AI, public verification, and invitation redemption endpoints.
- Audit-log tamper-evidence; app DB role cannot mutate versions/audit/signatures.

### NFR-2 Privacy & data protection
- Data residency configurable (region-pinned storage/DB).
- PII minimization in logs; structured logging with field-level redaction.
- Retention policy: draft agreements 24 months after last activity; finalized agreements per org policy (default 7 years metadata, configurable); AI transcripts 90 days; attachments per agreement lifecycle.
- GDPR-style rights: export, rectification, deletion with legal-hold overrides, implemented as documented policy procedures.

### NFR-3 Availability & durability
- Target: 99.9% availability for core app; RPO ≤ 15 min (PITR + daily backups), RTO ≤ 4 hours.
- All finalized documents + verification records backed up with cross-region replication (configurable).

### NFR-4 Performance
- API p95 latency < 400 ms for standard CRUD; document render < 3 s for ≤ 30-page agreement; QR verify page < 1.5 s.
- Support 10k active agreements / 1k concurrent users in v1 architecture (horizontal scaling path documented).
- List endpoints paginated (cursor-based) with index coverage guarantees.

### NFR-5 Scalability
- Stateless API tier behind load balancer; async work (rendering, PDF, notifications, AI) via queue workers.
- Object storage for artifacts; DB read replicas for reporting/verification reads.
- Modular monolith first (clear bounded contexts), able to split hot components (PDF worker, AI service) independently.

### NFR-6 Availability of AI provider
- Provider-agnostic AI gateway (OpenAI-compatible/Anthropic/local) with abstraction, timeouts, circuit breaker, and graceful degradation ("AI unavailable", never blocking core signing flows).

### NFR-7 Accessibility
- WCAG 2.1 AA: keyboard navigable flows (including signature), semantic markup, ARIA where needed, visible focus, ≥4.5:1 contrast, reduced-motion support, screen-reader tested on create/sign/verify flows.

### NFR-8 Responsiveness / mobile
- Mobile-first breakpoints; full agreement creation, review, and **signing** flow usable on phones (signing is the priority mobile flow).
- Touch-friendly signature pad; QR verify page designed for mobile scanning.

### NFR-9 Internationalization
- i18n from day one for UI strings (en first, structure ready for more); dates/numbers locale-aware; agreement content language per template.

### NFR-10 Maintainability & modularity
- Monorepo with strict module boundaries; no cross-module DB table access outside each module's repository.
- Typed end-to-end (TypeScript strict), generated API types from OpenAPI, contract tests.
- Feature flags for AI and new categories.

### NFR-11 Observability
- Structured logs (request ID correlation), metrics (latency, error rate, queue depth, AI failures, render time), tracing on critical paths, health/readiness endpoints, error tracking (Sentry-compatible).

### NFR-12 Compliance posture (non-legal, technical)
- ESIGN/eIDAS-informed design: attribution, intent, integrity, consent-to-electronic records, recorded explicitly in signature flow ("I intend to sign this version (hash …)").
- Clear separation so marketing/UI never claims legal validity.

---

## 3. User Roles

| Role | Scope | Capabilities |
|---|---|---|
| **Platform Admin** | System | Template/category management, feature flags, system audit, abuse handling. Cannot read agreement contents by default (break-glass procedure with audit). |
| **Organization Owner** | Org | Billing, member management, org settings, all agreement permissions, data export. |
| **Organization Admin** | Org | Member invites (limited), template customization, all agreement permissions. |
| **Creator / Drafter** | Org | Create agreements, edit fields, run AI assistance, manage parties, request signatures. |
| **Reviewer** | Org/Agreement | View, comment, propose changes, approve/reject. |
| **Signer (internal)** | Agreement | Approve + sign assigned versions. |
| **External Guest, Counterparty** | Single agreement (invitation-scoped) | View assigned version, comment, approve, sign. No other access. |
| **Viewer/Observed** | Agreement | Read-only access (e.g., finance/ops stakeholders). |
| **Public Visitor** | None | Public verification page only (metadata, no content). |

Permission model: **RBAC (org roles) + ABAC (agreement-level party role, status-based rules)**. Detailed matrix in §8.

---

## 4. User Journeys

### J1: Freelancer creates a service agreement (happy path)
1. signs up / logs in → lands in Home organization.
2. "New agreement" → category **Freelance/Service Agreement** → template "Standard Freelance Contract".
3. pastes a plain-language brief → AI extracts suggested fields (client name **flagged as unknown**, scope, fee) → user reviews each chip: **USER-PROVIDED vs AI-SUGGESTED** → accepts/edits/rejects.
4. Fills remaining required fields; AI flags "missing: termination clause" → user adds section or dismisses with reason.
5. Previews rendered document → saves draft (`DRAFT`).
6. Adds counterparty (email) → invites → guest opens link → `REVIEW`.
7. Guest comments on §3 (negotiation) → contributor edits → **Version 2** created with change summary → diff shown to guest.
8. Both parties approve (electronic acceptance) → `AWAITING_SIGNATURES`.
9. Signers sign (OTP for guest, session for member) → finalization → version status `FINAL`, hash sealed, `AGR-GH-2026-000001` + QR generated → status `ACTIVE`.
10. Both parties download PDF; `DOCUMENT_DOWNLOADED` audit events recorded.
11. QR printed; anyone scanning sees public verification: **VERIFIED**.

### J2: Landlord & tenant negotiate a rental agreement
Create (Rental) → tenant invited → comments + proposed changes → versions 1..4 with change summaries → approvals → signatures → ACTIVE → 30 days before expiry: `EXPIRING` + reminders → on expiry date → `EXPIRED` → optional renewal creates a linked agreement (new ID, reference to predecessor).

### J3: NDA with a fast external counterparty
Creator selects NDA template, fills parties, sends invite → guest sees preview + "Ask questions" → approves → signs via email OTP (consent-to-electronic checkbox) → finalization → both get PDF + verification QR. Total guest UX requires **no account creation** (magic link, single-agreement scope).

### J4: Reject & cancel
Reviewer rejects with reason → `REJECTED` (terminal) or creator cancels draft → `CANCELLED` with reason; all parties notified; audit events recorded; documents remain readable in archive.

### J5: Verification by a third party
Recipient scans QR from the printed PDF → public page shows Agreement ID, status ACTIVE, version 3, finalization date, **Integrity: VERIFIED** → no contract content revealed.

### J6: Owner manages portfolio
Dashboard: pending signatures (with "send reminder" action), upcoming expiries, recent activity; filters by category/status; bulk reminder for overdue signatures.

### J7: AI assistance safety moment
User asks AI "what's missing?" → AI returns potential gaps (e.g., "No dispute-resolution section") with rationale referencing the **template baseline**, explicitly labeled AI-SUGGESTED, with disclaimer. AI does **not** insert text into the agreement; user inserts and confirms.

---

## 5. System Architecture

### 5.1 Style
**Modular monolith** (single deployable API) + **async workers** + **static/edge-served public pages**, with strict module boundaries so modules can be extracted into services later without redesign.

```
                       ┌──────────────────────────────┐
   Browser (SPA) ──────▶  CDN / Edge (static, images) │
   Mobile web  ──────▶  WAF + Rate limit              │
        │              └──────────────┬───────────────┘
        │ HTTPS/JSON                  │
        ▼                             ▼
┌───────────────────────────── Web/API tier (stateless) ─────────────────────────────┐
│  API Gateway layer (auth middleware, rate limit, request-ID, RBAC/ABAC enforcer)   │
│  ┌────────────┐ ┌────────────┐ ┌─────────────┐ ┌────────────┐ ┌─────────────────┐  │
│  │ Identity   │ │ Agreement  │ │ Versioning  │ │ Signature  │ │ Verification    │  │
│  │ (auth,org, │ │ (lifecycle,│ │ (snapshots, │ │ (approval, │ │ (public page,   │  │
│  │  members)  │ │  parties,  │ │  diffs,     │ │  signing,  │ │  QR, hash       │  │
│  │            │ │  comments) │ │  hash)      │ │  finalize) │ │  checking)      │  │
│  └────────────┘ └────────────┘ └─────────────┘ └────────────┘ └─────────────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌─────────────┐ ┌────────────┐ ┌─────────────────┐  │
│  │ Templates  │ │ Audit      │ │ Notification│ │ AI Gateway │ │ Documents/Render│  │
│  │ & Categories│ │ (hash chain│ │ (in-app,    │ │ (provider  │ │ (HTML→PDF, QR)  │  │
│  │            │ │  timeline) │ │  email,     │ │  agnostic, │ │                 │  │
│  │            │ │            │ │  scheduler) │ │  guard)    │ │                 │  │
│  └────────────┘ └────────────┘ └─────────────┘ └────────────┘ └─────────────────┘  │
└───────────────────────────────────┬────────────────────────────────────────────────┘
                                    │
        ┌──────────────┬────────────┼───────────────┬────────────────┐
        ▼              ▼            ▼               ▼                ▼
  PostgreSQL      Redis         S3-compatible    Queue worker     Provider AI
  (primary +      (sessions,    object storage   (render, notify, (OpenAI-compat
   PITR backup,    rate limit,   (PDFs, uploads,  AI jobs,         or Anthropic,
   read replica)   cache,        artifacts)       reminders)       gateway)
                   locks)
```

### 5.2 Technology choices (established, inexpensive to run)

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | **React + TypeScript (Vite) + TanStack Query + React Router**, Tailwind + headless UI components | Ecosystem maturity, fast dev, cheap hosting (static CDN) |
| Backend | **Node.js + TypeScript + Fastify (or NestJS for heavier DI)** | Shared types with frontend, one language, strong ecosystem |
| API style | REST + OpenAPI 3 (generated types), **not** GraphQL in v1 | Simplicity, cacheability, easy contract tests |
| DB | **PostgreSQL 16** (UUIDv7 PKs, JSONB for content snapshots, row-level checks) | Relational integrity + flexible content; single DB keeps dev cost low |
| Cache/locks | **Redis** | Sessions, rate limits, distributed locks for ID counters/rendering |
| Object storage | **S3-compatible (MinIO in dev)** | Cheap, immutable-friendly, versioning |
| Queue | **BullMQ (Redis)** | Simple, enough at this scale |
| PDF | **Playwright/Chromium print-to-PDF** from server-rendered HTML (or Puppeteer) | Best typography control, template HTML reusable for on-screen preview |
| QR | `qrcode` npm (SVG/PNG), encoding public verify URL | Standard, no custom implementation |
| Hashing | Node `crypto`: SHA-256 (documents), **Ed25519 optional** for signature payload signing | Built-in, auditable |
| Auth | **Auth.js (NextAuth-style) or Lucia/Handrolled + Argon2**, email OTP via provider | Avoid heavy identity infra in v1 |
| Email | **Resend/Postmark/SES** behind an interface | Swap freely |
| AI | Provider-agnostic gateway: OpenAI-compatible + Anthropic; structured-output JSON schema; prompts versioned in repo | Portability + guardrails |
| Dev/ops | Docker Compose (Postgres/Redis/MinIO/Mailpit) + GitHub Actions; single small VM or Fly.io/Railway in dev | Very low dev cost |
| Testing | Vitest (unit), Supertest (API), Playwright (E2E), Testcontainers (integration) | Standard |

### 5.3 Module boundaries (bounded contexts)
`identity`, `organizations`, `templates`, `agreements` (incl. parties/comments/lifecycle), `versions`, `signatures` (approvals/signing/finalization), `audit`, `documents` (render/QR/store), `verification`, `notifications`, `ai`, `attachments`. Each module owns its tables, exposes a typed service interface, and may only communicate with others via service interfaces or domain events, never by direct table access.

### 5.4 Domain events (in-process bus, outbox-ready)
`AgreementCreated`, `StatusChanged`, `VersionCreated`, `PartyInvited`, `PartyViewed`, `CommentAdded`, `ApprovalRecorded`, `SignatureRecorded`, `AgreementFinalized`, `VerificationPerformed`, `ReminderDue`. Handlers: audit writer, notification dispatcher, document renderer, AI usage logger. **Transactional outbox** pattern so events are never lost.

---

## 6. Database Entity Relationships

### 6.1 ER overview

```
User ──< OrganizationMember >── Organization
 │                                   │
 │                                   ├──< Agreement ──< AgreementParty ──> User (optional)
 │                                   │      │             └── Invitation
 │                                   │      ├──< AgreementSection ──< AgreementField
 │                                   │      ├──< AgreementVersion (self: previous_version_id)
 │                                   │      ├──< Approval
 │                                   │      ├──< Signature
 │                                   │      ├──< AuditEvent (hash-chained)
 │                                   │      ├──< VerificationRecord
 │                                   │      ├──< Comment ──> AgreementSection (optional)
 │                                   │      ├──< Attachment
 │                                   │      └──< Notification
 │                                   │
 └──< Notification                    AgreementTemplate ──> AgreementTemplateCategory
                                        └──< TemplateSection ──< TemplateField
                                        └── (template_version pinned on agreement)
```

### 6.2 Tables (key columns)

**user**, `id (uuidv7 pk)`, `email (unique, citext)`, `password_hash (nullable for OAuth)`, `email_verified_at`, `display_name`, `mfa_enabled`, `locale`, `status (ACTIVE|SUSPENDED|DELETED)`, `created_at`, `updated_at`.

**organization**, `id`, `name`, `slug (unique)`, `owner_user_id`, `settings (jsonb: agreement_id_prefix, signing_policy, reminder_policy, retention_policy)`, `created_at`.

**organization_member**, `id`, `org_id`, `user_id`, `role (OWNER|ADMIN|CREATOR|REVIEWER|MEMBER)`, `status`, `invited_by`, `joined_at`. Unique(org_id, user_id).

**agreement_template_category**, `id`, `code (FREELANCE|RENTAL|PROPOSAL|NDA|CLIENT)`, `label_key`, `icon`, `is_enabled`, `sort_order`, `requires_legal_review (bool)`, **adding a category = inserting a row + i18n keys** (FR-2.4).

**agreement_template**, `id`, `category_id`, `name`, `description`, `template_version (int)`, `content_schema (jsonb)`, `render_template_key`, `signing_policy (PARALLEL|SEQUENTIAL)`, `required_approvals`, `status (PUBLISHED|DRAFT|RETIRED)`, `created_by`, `created_at`.

**template_section**, `id`, `template_id`, `order_index`, `code`, `title_key`, `body_template (text with {{placeholders}})`, `is_required`, `ai_baseline_notes (jsonb, used by missing-section detection)`.

**template_field**, `id`, `section_id`, `code`, `label_key`, `type (TEXT|NUMBER|MONEY|DATE|EMAIL|URL|BOOLEAN|SELECT|PARTY_REF|SIGNATURE)`, `validation (jsonb)`, `is_required`, `kind (USER|COMPUTED)`, `visibility_rules (jsonb)`.

**agreement**, `id (uuidv7 pk)`, `public_id (AGR-GH-2026-000001, unique indexed)`, `org_id`, `title`, `category_id`, `template_id`, `template_version`, `status`, `current_version_id`, `final_version_id (nullable)`, `created_by`, `expires_at`, `finalized_at`, `counterparty_summary (jsonb, minimal)`, `deleted_at`, `created_at`, `updated_at`.

**agreement_party**, `id`, `agreement_id`, `user_id (nullable for external)`, `email`, `display_name`, `role (OWNER|CONTRIBUTOR|REVIEWER|SIGNER|OBSERVER)`, `signing_order (int)`, `status (INVITED|VIEWED|APPROVED|SIGNED|DECLINED)`, `added_at`, `signed_at`. Unique(agreement_id, email).

**agreement_section**, `id`, `agreement_id`, `template_section_id`, `order_index`, `code`, `title`, `body_current (text)`, `is_included (bool)`, `included_reason`.

**agreement_field**, `id`, `agreement_id`, `section_id`, `code`, `value (jsonb)`, `provenance (USER_PROVIDED|AI_SUGGESTED_CONFIRMED|COMPUTED)`, `ai_suggestion_id (nullable)`, `updated_by`, `updated_at`.

**agreement_version**, `id`, `agreement_id`, `version_number (int)`, `content (jsonb full snapshot)`, `document_hash (char(64))`, `previous_version_id (nullable)`, `change_summary`, `status (DRAFT|SUPERSEDED|PENDING_APPROVAL|APPROVED|FINAL|REJECTED)`, `created_by`, `created_at`, `finalized_at`. **Append-only; unique(agreement_id, version_number); trigger blocks UPDATE of content/hash for FINAL.**

**approval**, `id`, `agreement_id`, `version_id`, `party_id`, `decision (APPROVED|REJECTED)`, `comment`, `decided_at`, `actor_ip`, `actor_ua`, `payload_hash`.

**signature**, `id`, `agreement_id`, `version_id`, `party_id`, `signer_user_id (nullable)`, `signer_email`, `method (EMAIL_OTP|SESSION|IMAGE)`, `signed_at`, `document_hash_at_signing`, `signature_payload_hash`, `public_key (nullable)`, `signature_image_path (nullable)`, `otp_verification_id`, `actor_ip`, `actor_ua`, `consent_text_version`.

**audit_event**, `id`, `agreement_id (nullable for org-level)`, `org_id`, `seq (per-agreement int)`, `event_type`, `actor_type (USER|GUEST|SYSTEM|AI)`, `actor_id`, `actor_label`, `metadata (jsonb)`, `occurred_at`, `prev_hash`, `event_hash`, where `event_hash = SHA-256(prev_hash ‖ canonical(event))` (tamper-evident chain per agreement). **Append-only.**

**verification_record**, `id`, `agreement_id`, `version_id`, `checked_at`, `result (VERIFIED|MISMATCH|NOT_FOUND)`, `source (QR|URL|API|MANUAL)`, `requester_hash (hashed IP for abuse analysis)`, `recomputed_hash`.

**notification**, `id`, `user_id`, `org_id`, `agreement_id (nullable)`, `type`, `payload (jsonb)`, `channel_status (jsonb: inapp/email)`, `read_at`, `created_at`, `dedupe_key`.

**comment**, `id`, `agreement_id`, `version_id`, `section_id (nullable)`, `parent_id (nullable)`, `author_type (USER|GUEST)`, `author_id`, `body`, `resolved_at`, `created_at`.

**invitation**, `id`, `agreement_id`, `email`, `role`, `token_hash`, `expires_at`, `accepted_at`, `revoked_at`, `created_by`, `max_uses (default 1)`.

**attachment**, `id`, `agreement_id`, `uploaded_by`, `filename`, `content_type`, `size_bytes`, `storage_key`, `sha256`, `scan_status (PENDING|CLEAN|REJECTED)`, `created_at`.

**ai_interaction**, `id`, `user_id`, `org_id`, `agreement_id (nullable)`, `feature (EXTRACT|EXPLAIN|GAPS|QUESTIONS|SUMMARIZE)`, `prompt_version`, `model`, `input_ref`, `output (jsonb)`, `validation_status`, `tokens_in/out`, `created_at`. *(Separate from agreement data per FR-9.8.)*

**id_counter**, `key (e.g., 'AGR-GH-2026')`, `next_value`, `updated_at`. Row lock during allocation (FR-4.3).

**reminder_rule / scheduled_job**, reminder templates, cadence, caps, cron state (or BullMQ repeatable jobs).

### 6.3 Cardinality notes
- One agreement → many versions; exactly zero-or-one `final_version_id`.
- Audit chain is **per agreement** (`seq` + `prev_hash` ordered by `seq`), making chain verification cheap.
- `agreement_field` provenance makes USER vs AI distinction **persisted, not just displayed**.
- Soft-delete only on `agreement` (`deleted_at`); versions/audit/signatures are never deleted.

---

## 7. API Architecture

### 7.1 Conventions
- Base: `/api/v1`; JSON; UTC ISO-8601; UUIDv7 for internal ids; cursor pagination (`?cursor=&limit=`); idempotency keys on POST mutation endpoints that trigger side effects (signing, invitations, rendering).
- Errors: RFC 7807 problem+json (`type`, `title`, `status`, `detail`, `code`, `requestId`).
- Auth: short-lived access token (JWT, 15 min) + rotating refresh token (httpOnly, SameSite=Strict) **or** server sessions in Redis, decided in milestone 1 (recommend server sessions for simpler revocation).
- CSRF: double-submit token for cookie-based session flows.
- OpenAPI spec generated from route schemas; frontend types generated from spec.
- Every response carries `X-Request-Id`.

### 7.2 Endpoint map (representative, not exhaustive)

**Auth & identity**
```
POST   /auth/register                 POST   /auth/login
POST   /auth/logout                   POST   /auth/refresh
POST   /auth/verify-email             POST   /auth/otp/request  {email, purpose}
POST   /auth/otp/verify               GET    /me
POST   /me/mfa/setup                  POST   /me/mfa/enable
GET    /me/sessions                   DELETE /me/sessions/:id
```

**Organizations**
```
POST   /orgs                          GET    /orgs/:id
PATCH  /orgs/:id                      GET    /orgs/:id/members
POST   /orgs/:id/invites              PATCH  /orgs/:id/members/:userId
DELETE /orgs/:id/members/:userId      GET    /orgs/:id/settings
PATCH  /orgs/:id/settings
```

**Templates & categories**
```
GET    /categories                          GET    /categories/:code/templates
GET    /templates/:id                       POST   /admin/templates        (platform admin)
PATCH  /admin/templates/:id                 POST   /admin/categories
```

**Agreements**
```
POST   /agreements                     {category, templateId, brief?}   → draft
GET    /agreements?status=&category=&q=  (cursor)
GET    /agreements/:id                  PATCH  /agreements/:id          (draft edits)
DELETE /agreements/:id                  (draft-only soft delete)
POST   /agreements/:id/status           {to, reason}  → lifecycle transition
GET    /agreements/:id/parties          POST   /agreements/:id/parties
DELETE /agreements/:id/parties/:partyId POST   /agreements/:id/parties/:partyId/resend
POST   /agreements/:id/sections/:sectionId/content
PATCH  /agreements/:id/fields/:fieldId  {value}  (records provenance)
```

**Versions**
```
POST   /agreements/:id/versions         {changeSummary} → new immutable version
GET    /agreements/:id/versions         GET    /agreements/:id/versions/:v
GET    /agreements/:id/versions/:a/diff/:b
POST   /agreements/:id/versions/:v/submit   (PENDING_APPROVAL)
```

**Comments & approvals (review/negotiation)**
```
GET    /agreements/:id/comments?version=&section=
POST   /agreements/:id/comments         {versionId, sectionId?, parentId?, body}
POST   /agreements/:id/versions/:v/approvals   {decision, comment}
```

**Invitations & guest access**
```
POST   /invitations/redeem              {token}          → guest session (scoped)
GET    /guest/agreements/:id            (guest-scoped read)
POST   /guest/agreements/:id/comments   POST   /guest/agreements/:id/approvals
POST   /guest/agreements/:id/sign       {otp?}
```

**Signature & finalization**
```
POST   /agreements/:id/signature-requests     {partyIds, order}  (SIGNATURE_REQUESTED)
POST   /agreements/:id/versions/:v/sign       {method, consent}  (DOCUMENT_SIGNED)
POST   /agreements/:id/finalize               (AGREEMENT_FINALIZED), server validates policy
GET    /agreements/:id/signature-status
```

**Documents**
```
GET    /agreements/:id/documents/:v/preview     (HTML)
POST   /agreements/:id/documents/:v/render      (queue) → GET .../pdf (signed URL)
GET    /agreements/:id/documents/:v/download    (DOCUMENT_DOWNLOADED audit)
GET    /agreements/:id/qr
```

**Verification (public)**
```
POST   /public/verify                 {agreementId} or {id, hash} → metadata only
GET    /verify/:publicId              (SPA public page, no auth)
```

**Audit**
```
GET    /agreements/:id/audit          (timeline, cursor), viewers: org members w/ access
GET    /agreements/:id/audit/export   (CSV/PDF)
```

**Notifications**
```
GET    /notifications                 POST  /notifications/:id/read
POST   /notifications/read-all        GET    /me/notification-preferences
PATCH  /me/notification-preferences   POST   /agreements/:id/remind   (send reminder)
```

**AI**
```
POST   /agreements/:id/ai/extract     {brief}      → suggestions[] (provenance-tagged)
POST   /agreements/:id/ai/explain     {sectionId}
POST   /agreements/:id/ai/gaps        {}           → missingSections[]
POST   /agreements/:id/ai/questions   {}
POST   /agreements/:id/ai/summarize   {versionId, length}
POST   /agreements/:id/ai/accept      {suggestionId, targetField|section}  (user action)
```

**Attachments**
```
POST   /agreements/:id/attachments    (multipart)   GET /attachments/:id (signed URL)
```

### 7.3 Authorization enforcement
Every agreement-scoped route passes through a single `resolveAgreementAccess` interceptor: validates org membership → agreement party role → status-based permission (e.g., only `DRAFT` editable, only `AWAITING_SIGNATURES` signable). Deny by default.

---

## 8. Authentication Strategy

1. **Primary:** email + password (Argon2id) with verified email; server-side session in Redis (httpOnly, Secure, SameSite=Strict cookie) + CSRF double-submit. Rationale: trivial revocation, no token-refresh complexity at this scale. JWT upgrade path documented for future service extraction.
2. **Passwordless option:** email **OTP** (6-digit, 10-min expiry, rate-limited, single-use), doubles as the external signer verification method (FR-10.2).
3. **OAuth/OIDC:** Google/Microsoft (v1.1), same `email`-based account linking.
4. **MFA:** TOTP (App) optional for users, enforceable per org policy; recovery codes.
5. **External guests:** magic link (signed, single-agreement scope, 72h default expiry, max uses, token hash stored). Guest session is a distinct principal type with a hard-coded narrow permission set. No org context, no cross-agreement access.
6. **Signing strength:** a signature requires **either** authenticated session **or** fresh OTP (≤5 min old) bound to the specific version hash at signing time; OTP verification id is persisted in the signature record.
7. **Session security:** fingerprint/user-agent binding (soft), idle timeout 7d sliding for members / 15 min for guests, revoke-all on password change, anomaly-based forced logout.
8. **Service/API keys:** for future public verification API, hashed keys, scopes, rate limits.

---

## 9. Authorization Strategy

**Model: RBAC (org roles) + ABAC (agreement party role + agreement status + resource ownership), enforced centrally.**

### 9.1 Permission matrix (abridged)

| Capability | Owner | Admin | Creator | Reviewer | Member | Party(CONTRIBUTOR) | Party(REVIEWER) | Party(SIGNER) | Guest | Public |
|---|---|---|---|---|---|---|---|---|---|---|
| View agreement (org) | ✓ | ✓ | ✓ | ✓ | ✓* | ✓ (assigned) | ✓ | ✓ | assigned ver only | ✗ |
| Create agreement | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Edit fields (draft) | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ (status-gated) | ✗ | ✗ | ✗ | ✗ |
| Comment | ✓ | ✓ | ✓ | ✓ | ✓* | ✓ | ✓ | ✓ | ✓ | ✗ |
| Propose new version | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ (if allowed) | ✗ | ✗ | ✗ | ✗ |
| Approve (acceptance) | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Sign | as party | as party | as party | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| Finalize | ✓ | ✓ | ✓ | ✗ | ✗ | policy-based | policy-based | policy-based | ✗ | ✗ |
| Invite/remove party | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Cancel/Terminate | ✓ | ✓ | creator | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| View audit timeline | ✓ | ✓ | ✓ | ✓ (agreed) | ✗ | own actions+ | ✗ | own actions+ | ✗ | ✗ |
| Download PDF | ✓ | ✓ | ✓ | ✓ | ✓* | ✓ | ✓ | ✓ | ✓ | ✗ |
| Public verification | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | metadata only |

\* = only for agreements they can see; data-scoping enforced in repository layer (`org_id` predicate mandatory, integration-tested against IDOR).

### 9.2 Enforcement mechanics
- Declarative policy definitions per route (`requireOrgRole(...)`, `requirePartyRole(...)`, `requireStatus(...)`).
- Single access-resolver service; no ad-hoc checks in handlers.
- Negative tests for every route (attempt as wrong org/wrong party/wrong status) as part of CI.
- Platform admin has **no content access by default**; break-glass access requires a recorded `ADMIN_BREAK_GLASS` audit event + time-limited grant.

---

## 10. Agreement Lifecycle

### 10.1 State machine

```
                    ┌──────────┐  submit for review  ┌──────────┐
        create ────▶│  DRAFT   │────────────────────▶│  REVIEW  │
                    └────┬─────┘                     └────┬─────┘
                         │ cancel                         │ request changes / reject
                         ▼                                ▼
                   ┌───────────┐  counterparty proposes  ┌───────────────┐
                   │ CANCELLED │◀────────────────────────│ NEGOTIATION   │
                   └───────────┘      edits (versions)   └──────┬────────┘
                         ▲                                      │ all approvals
                         │ cancel                               ▼
                   ┌─────────────────────┐  sign  ┌──────────────────────┐
                   │ AWAITING_SIGNATURES │───────▶│      ACTIVE          │
                   └──────────┬──────────┘        └──────┬───────┬───────┘
                              │ reject / cancel          │ T-30d │ terminate
                              ▼                          ▼       ▼
                        ┌───────────┐             ┌─────────┐ ┌────────────┐
                        │ REJECTED  │             │ EXPIRING│ │ TERMINATED │
                        └───────────┘             └────┬────┘ └────────────┘
                                                       │ expiry date
                                                       ▼
                                                    ┌────────┐
                                                    │ EXPIRED│
                                                    └────────┘
```

### 10.2 Transition matrix (authoritative)

| From → To | Trigger | Guard |
|---|---|---|
| DRAFT → REVIEW | creator submits | required fields complete; ≥1 party |
| REVIEW → DRAFT | changes requested | contributor only |
| REVIEW → NEGOTIATION | counterparty proposes edits | at least one external party |
| NEGOTIATION → REVIEW | new version submitted | change summary required |
| REVIEW/NEGOTIATION → AWAITING_SIGNATURES | all approvals recorded | approval policy satisfied |
| REVIEW/NEGOTIATION → REJECTED | reviewer rejects | reason required |
| any non-terminal → CANCELLED | owner/admin | reason required |
| AWAITING_SIGNATURES → ACTIVE | all required signatures | hash sealed, final version set |
| AWAITING_SIGNATURES → REJECTED/CANCELLED | signatory declines / owner cancels | reason required |
| ACTIVE → EXPIRING | scheduler (T-30d, configurable) | `expires_at` set |
| ACTIVE → TERMINATED | owner/admin | reason required |
| EXPIRING → ACTIVE | renewed (new `expires_at`) or extension | audit event |
| EXPIRING → EXPIRED | scheduler on `expires_at` | — |
| EXPIRED/TERMINATED/CANCELLED/REJECTED | — | terminal (no exit; renewal = new linked agreement) |

- Rules live in a **declarative transition table** in code (single source), validated at runtime; adding a state = add row(s) + UI handling.
- Every transition: permission check → DB tx → status update → audit event → outbox event → notifications.

---

## 11. Version-Control Strategy

1. **Snapshot immutability.** A version stores the complete agreement content snapshot (sections + fields, canonical JSON), not a diff-from-previous. Storage cost is negligible vs. auditability benefit; diffs are computed on demand.
2. **Creation points:** first "meaningful save" (v1), any field/section edit while status ∈ {REVIEW, NEGOTIATION} (auto-batch with 60s debounce), explicit "propose changes" by a counterparty, template upgrade application, restoration of a previous version (creates a new version with `change_summary = "Restored from v2"`).
3. **Content canonicalization before hashing:** deterministic JSON serialization (sorted keys, normalized whitespace in text, normalized line endings, no timestamps in hashed payload) → SHA-256 → `document_hash`. Same content ⇒ same hash across machines.
4. **previous_version_id** forms a linked list; integrity check: walking the chain and re-hashing snapshots must reproduce stored hashes.
5. **Status per version:** `DRAFT → PENDING_APPROVAL → APPROVED → FINAL` or `REJECTED`; non-final versions become `SUPERSEDED` when a successor is created.
6. **Finalization:** exactly one `FINAL` version at a time; trigger-level DB constraint prevents content/hash mutation of `FINAL` rows; `final_version_id` on agreement points to it.
7. **Post-signature changes:** never mutate. If parties want changes after finalization → "amendment flow": new agreement version chain starting from final content, or a new linked agreement; the original final version stays sealed.
8. **Rendering reproducibility:** rendered PDF for a FINAL version is hashed and stored; a later re-render must match (CI test with golden documents).
9. **Diffing:** field-level diff (added/removed/changed) and section-body diff (unified text diff), stored nowhere, computed live from snapshots.

---

## 12. Audit-Log Strategy

1. **What is logged:** the full event list from the requirements (CREATED, UPDATED, VERSION_CREATED, PARTY_INVITED, PARTY_VIEWED, PARTY_COMMENTED, PARTY_APPROVED, SIGNATURE_REQUESTED, DOCUMENT_SIGNED, AGREEMENT_FINALIZED, DOCUMENT_DOWNLOADED, DOCUMENT_VERIFIED, AGREEMENT_CANCELLED, AGREEMENT_TERMINATED, plus REJECTED, STATUS_CHANGED, INVITATION_ACCEPTED, REMINDER_SENT, AI_ASSISTED, EXPORTED, ADMIN_BREAK_GLASS).
2. **Append-only + tamper-evident:** per-agreement hash chain: `event_hash = SHA-256(prev_hash ‖ canonical(event_body))`. DB role lacks UPDATE/DELETE on `audit_event`. Nightly job verifies chains and alerts on breaks. Optional: periodic anchor of the latest per-agreement hashes into an external timestamp/hash service (v2).
3. **Payload:** `event_type`, `actor` (user/guest/system/AI + label), `agreement_id`, `seq`, `occurred_at` (server time, UTC), `metadata` (typed per event, e.g., signature events include version + hash, status events include from/to + reason, download events include format), `ip/ua` where relevant, `request_id`.
4. **Write path:** synchronous within the same DB transaction as the domain change (via outbox row) → guarantees no event without state change and vice versa. A background applier publishes to notification/email handlers.
5. **Privacy:** metadata is allow-listed per event type (no free-form PII dumping); guest actors stored as email + label; AI events store feature/model/token counts, not prompt bodies (those live in `ai_interaction`).
6. **Presentation:** per-agreement timeline UI with filters by event type/actor/date; CSV export; human-readable phrasing per event type (i18n).
7. **Retention:** agreement lifetime + org retention policy; on user deletion, actor identity anonymized, event retained; legally-required deletion handled by documented procedure.

---

## 13. Digital-Signature Strategy

**Goal:** strong evidence of attribution, intent, and integrity, with honest positioning (not "legally guaranteed signature").

1. **What is signed:** the `document_hash` of the FINAL candidate version. The signing payload is canonical:
   `payload = {agreementPublicId, versionNumber, documentHash, signerId|signerEmail, signedAtUTC, nonce, consentTextVersion}`
   `signature_payload_hash = SHA-256(canonical(payload))`.
2. **Methods (v1):**
   - `SESSION`, authenticated org member, checkbox intent + optional typed/drawn signature image (stored, not part of hash).
   - `EMAIL_OTP`, external guest proves email control via fresh OTP bound to the payload hash.
   - Both record `signed_at`, IP, user-agent, consent text version shown.
3. **Integrity verification:** `verify(payload, signature_payload_hash)` recomputes from stored records; document hash re-check proves the document was not altered. This is the whole verification story: **identity evidence + consent evidence + hash chain**.
4. **Asymmetric option (v1.1):** server holds an Ed25519 key; finalization signs the final hash producing a detachable signature block on the PDF (verifiable offline with published public key). Keeps cost at zero while adding non-repudiation of the platform's attestation. (Document clearly: platform attestation, not PKI/certificate-authority signature.)
5. **Signing orchestration:** approval policy → signature requests (`SIGNATURE_REQUESTED`) → sequential/parallel collection per template policy → on completion, server-side `finalize()` (single transaction): set FINAL version, seal hash, set `finalized_at`, generate verification record + QR, dispatch certificates to parties.
6. **Failure/edge handling:** signer declines (→ REJECTED), OTP retries capped, session expiry mid-sign (resume via re-request), duplicate signing prevented by unique constraint (agreement, version, party).
7. **Evidence pack download:** parties can download "signature evidence" (JSON with payload, hashes, timestamps, audit chain head), supports later independent verification.

---

## 14. Verification Strategy

1. **At finalization:** store `VerificationRecord` initial row (`result = VERIFIED`, source = SYSTEM) containing agreement public id, version, final hash, finalized_at.
2. **QR code:** SVG/PNG of `https://<host>/verify/<publicId>` (or `/verify/<publicId>-<8charHashPrefix>` for pre-screening). Rendered in document footer and in-app "Verify" panel.
3. **Public page (SPA route, unauthenticated):**
   - Shows: Agreement ID, Status, Version, Created date, Finalized date, Integrity status, Category, plus "This page confirms the document has not been modified since finalization. It does not display agreement contents and does not constitute legal advice."
   - Response never includes content, party names, comments, hashes of *content* beyond a truncated integrity hash prefix.
4. **Check algorithm:** lookup by public id (rate-limited, cached 60s) → compare stored final hash vs. (a) stored artifact hash if a document is uploaded for verification later (v1.1 "upload to verify" feature), or (b) internal consistency (chain walk). Result `VERIFIED | MISMATCH | NOT_FOUND` + timestamp; each check writes a record + `DOCUMENT_VERIFIED` audit event (logged with hashed requester IP).
5. **Abuse controls:** IP+identifier rate limit, bot challenge on repeated misses, no enumeration hints (uniform NOT_FOUND response), optional CAPTCHA after threshold.
6. **Offline verification:** printed documents show Agreement ID + 12-char hash prefix + URL; verification page accepts manual hash-prefix comparison.

---

## 15. AI Architecture

### 15.1 Placement
A dedicated **AI Gateway module** inside the monolith, the only module allowed to call external model providers.

```
UI (AI panels) → /agreements/:id/ai/* → AI Gateway
   1. Permission check (agreement access)
   2. Context builder (template metadata, user-provided fields only, never other users' data)
   3. Prompt template (versioned in repo: prompts/vN/*.md)
   4. Provider adapter (OpenAI-compat | Anthropic | local) with timeout(20s), retry(1), circuit breaker
   5. Structured output validation (JSON Schema + provenance rules)
   6. Sanitization (strip any literal facts not derived from inputs, heuristic + schema enforcement)
   7. Persist ai_interaction (validation_status) → return suggestions tagged AI-SUGGESTED
   8. Usage audit event + metrics
```

### 15.2 Features & prompts
| Feature | Input context | Output schema |
|---|---|---|
| `EXTRACT` | user brief + template fields | `suggestions: [{fieldCode, value, confidence, source: "USER_BRIEF", quote}]` |
| `EXPLAIN` | template section body + agreement's actual values | `explanation, plainLanguage, considerThis[]` |
| `GAPS` | current sections/fields vs template baseline | `gaps: [{sectionCode, reason, severity, evidence: "template baseline expects X"}]` |
| `QUESTIONS` | current state | `questions: [{targetField, question, why}]` |
| `SUMMARIZE` | version snapshot | `{short, medium}` |

### 15.3 Guardrails (enforced, not aspirational)
- **Provenance typing in schema:** every AI claim carries `source ∈ {USER_INPUT, TEMPLATE_BASELINE}`; validator rejects outputs where `source` is missing.
- **No fabrication:** prompts instruct "do not supply values absent from input; use `unknown`"; validator flags any suggestion for `name/price/date/address/obligation` fields whose value string doesn't appear in the user brief or template → dropped pre-response.
- **Never auto-commit:** AI output goes to suggestion state only; acceptance is an explicit user action recorded with provenance `AI_SUGGESTED_CONFIRMED`.
- **UI separation:** AI results render in visually distinct "AI suggestion" cards with chips (AI-SUGGESTED / USER-PROVIDED), the standing disclaimer, and Accept/Reject buttons.
- **AI identity in audit:** `AI_ASSISTED` events; AI never appears as actor for domain changes (actor_type `AI` used only for the AI interaction itself).
- **Degradation:** provider failure ⇒ feature-off response, core flows unaffected.
- **Cost control:** per-org daily token budgets, caching of deterministic outputs (gaps for unchanged content), smaller model for summarize/explain.

### 15.4 Privacy
Only the current agreement's user-provided content and template baseline are sent. No cross-agreement data, no training on user data (provider settings), AI transcripts retention 90 days, org-level AI disable switch.

---

## 16. Notification Architecture

### 16.1 Channels
In-app (notification center, unread badge) primary; email secondary; webhook/PDFF-callbacks internal only. Channel fan-out from a single event.

### 16.2 Trigger catalog (event → recipients → default timing)

| Event | Recipients | Timing |
|---|---|---|
| PARTY_INVITED | invitee | immediate (email + in-app) |
| INVITATION_ACCEPTED | inviter | immediate |
| PARTY_VIEWED | creator | immediate in-app (digest if burst) |
| PARTY_COMMENTED / reply | thread participants | immediate in-app, email digest 1h |
| APPROVAL_REQUESTED | reviewers | immediate |
| PARTY_APPROVED / REJECTED | creator + other parties | immediate |
| SIGNATURE_REQUESTED | signers | immediate |
| **Pending signature reminder** | unsigned signers | T+3d, then every 3d, cap 5, then escalate to creator |
| DOCUMENT_SIGNED (partial) | creator | immediate |
| AGREEMENT_FINALIZED | all parties | immediate + email with PDF/links |
| DOCUMENT_DOWNLOADED | — | audit only (no notification) |
| **Expiry approach** | owner + signers | T-30d, T-7d, T-1d |
| EXPIRED / TERMINATED / CANCELLED / REJECTED | all parties | immediate |
| REMINDER_SENT (manual) | signer | immediate, rate-limited (1/24h per party) |
| Security events (login new device, password change) | user | immediate, non-disableable |

### 16.3 Mechanics
- Driven by **outbox events** → notification service applies rules → creates `notification` rows (in-app) → enqueues email jobs (BullMQ).
- **Scheduler:** repeatable jobs scan for due reminders/expiries (5-min granularity); status transitions (`ACTIVE→EXPIRING→EXPIRED`) executed in the same worker with row-level locking.
- **Preferences:** per-type toggles (immediate/digest/off) except security; org admins can configure reminder cadence within caps.
- **Dedupe:** `dedupe_key` (event+agreement+recipient+type) prevents duplicate emails.
- **Templates:** i18n message templates (subject/body) versioned with the codebase; unsubscribe/footer includes disclaimer.
- **Idempotency & retry:** at-least-once with exponential backoff; dead-letter queue surfaced in admin dashboard.

---

## 17. Security Model

**Defenses by layer:**

1. **Identity:** Argon2id, verified email, MFA option, OTP hardening (rate limit, single-use, short TTL), guest magic-link scoping, session revocation.
2. **Authorization:** deny-by-default resolver (§9), org-scoping in every repository query, IDOR test suite, admin break-glass audit.
3. **Transport/edge:** TLS everywhere, HSTS, secure/HttpOnly/SameSite cookies, CSP (no inline scripts; AI/CDN allowlist), CORS allowlist, WAF/rate limits (auth 5/min/IP, API 100/min/user, verify 10/min/IP).
4. **Application input:** schema validation on every endpoint (Fastify JSON schema / zod), parameterized queries only, output encoding (React escapes; PDF renderer uses text nodes not HTML concatenation), file upload restrictions (allowlist types, ≤25 MB, AV scan, store outside webroot, serve via signed URLs with content-disposition), SSRF: no user-controlled URLs server-side.
5. **Data:** encryption at rest (managed disk/S3), field-level encryption for OTP hashes/session tokens, secrets via env/secret manager, backups encrypted + tested restore quarterly.
6. **Immutability:** DB roles, app role can INSERT into `audit_event`, `agreement_version`, `signature`; cannot UPDATE/DELETE; trigger guards on FINAL versions; nightly hash-chain verification.
7. **AI-specific:** output schema validation, provenance enforcement, prompt-injection hygiene (user content sent in delimited context sections, system prompt never overridable by content, outputs treated as untrusted data not instructions), per-org token budgets.
8. **Public surface:** verification endpoint minimal disclosure, rate-limited, uniform errors; guest pages cannot enumerate (unguessable tokens, no id listing).
9. **Supply chain:** lockfiles, Dependabot/Renovate, CI secret scan, minimal base images.
10. **Process:** threat model for signing flow (STRIDE-lite) reviewed at milestone 1; security checklist per release; logging of auth failures; no PII in logs (redaction middleware).
11. **Compliance honesty:** UI copy review ensures no claim of legal advice or guaranteed legal validity anywhere (§0.4).

---

## 18. Proposed Folder Structure

Monorepo (pnpm workspaces + Turborepo):

```
AgreementHub/
├── docs/
│   ├── SPEC.md                      # this document
│   ├── adr/                         # architecture decision records (0001-*.md …)
│   └── api/                         # generated OpenAPI (committed on release)
├── apps/
│   ├── web/                         # React SPA
│   │   ├── public/                  # static assets, QR SVGs
│   │   └── src/
│   │       ├── app/                 # router, providers, error boundaries
│   │       ├── features/
│   │       │   ├── auth/            # login, register, otp, mfa
│   │       │   ├── dashboard/
│   │       │   ├── agreements/      # list, detail, lifecycle actions
│   │       │   ├── builder/         # template pick, fields, section editor
│   │       │   ├── ai/              # suggestion cards, explain panel, gaps
│   │       │   ├── negotiation/     # diff view, comments, approvals
│   │       │   ├── signing/         # consent, otp, signature pad
│   │       │   ├── documents/       # preview, pdf download, qr
│   │       │   ├── verify/          # PUBLIC verification page (no auth shell)
│   │       │   ├── notifications/
│   │       │   └── settings/        # org, members, preferences
│   │       ├── shared/              # ui kit, hooks, i18n, a11y helpers
│   │       └── test/                # unit + e2e (playwright lives in /e2e)
│   ├── api/                         # Fastify app (modular monolith)
│   │   └── src/
│   │       ├── main.ts              # bootstrap, config, plugins
│   │       ├── plugins/             # auth, csrf, rate-limit, request-id, errors
│   │       ├── modules/
│   │       │   ├── identity/        # routes/ service/ repo/ types/
│   │       │   ├── organizations/
│   │       │   ├── templates/
│   │       │   ├── agreements/      # lifecycle, parties, sections, fields, comments
│   │       │   ├── versions/
│   │       │   ├── signatures/      # approvals, signing, finalization
│   │       │   ├── audit/
│   │       │   ├── documents/       # render, pdf, qr
│   │       │   ├── verification/
│   │       │   ├── notifications/
│   │       │   ├── ai/              # gateway, prompts/, providers/, guards/
│   │       │   └── attachments/
│   │       ├── shared/              # domain errors, ids (uuidv7, publicId), hashing,
│   │       │                        # canonicalization, result types, events (outbox)
│   │       └── workers/             # queue consumers: render, email, reminders, expiry
│   └── admin/                       # platform admin (templates/categories/flags), v1.1
├── packages/
│   ├── contracts/                   # zod schemas + generated OpenAPI types (shared FE/BE)
│   ├── domain/                      # pure domain logic: state machine, transition table,
│   │                                # version hashing, canonicalization, permission matrix
│   ├── template-schema/             # template/section/field JSON schemas + validators
│   └── config/                      # eslint/tsconfig/vitest presets
├── db/
│   ├── migrations/                  # ordered SQL migrations (node-pg-migrate / drizzle)
│   ├── seeds/                       # 5 categories + starter templates
│   └── schema.sql                   # generated snapshot
├── e2e/                             # Playwright journeys (J1–J5)
├── infra/
│   ├── docker/                      # compose: postgres, redis, minio, mailpit
│   ├── ci/                          # GitHub Actions workflows
│   └── deploy/                      # Dockerfile(s), fly.toml / compose prod
├── .env.example
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

**Boundaries encoded in tooling:** ESLint `no-restricted-imports` prevents cross-module imports except through `modules/*/index.ts` service interfaces; each module owns its tables (repository checks in CI).

---

## 19. Development Milestones

> Each milestone ends with working, tested, demonstrable scope. Estimates are relative sizes (S/M/L) for a small team (1–2 devs + design/AI support).

### M0: Foundations (S–M)
Repo/tooling, Docker compose, CI (lint/test/build), Fastify skeleton, auth (register/login/session/OTP/verify), orgs + membership, RBAC middleware + access resolver, error/request-id/rate-limit plugins, base UI shell (routing, layout, i18n, a11y), design tokens.
**Exit:** user can register, create org, invite member; IDOR tests green.

### M1: Templates & Agreement drafting (M)
Template/category schema + migrations + seeds (5 categories), admin-side template CRUD (basic), agreement create flow (category → template → fields → preview), AgreementField provenance storage, public ID generator (per-year counters), draft autosave, agreement list + filters, attachments v1 (upload/scan/store).
**Exit:** FR-2, FR-3, FR-4 (drafts), FR-15 partially; J1 steps 1–5 demoable.

### M2: Versioning, audit & lifecycle (M)
Domain state machine + transition table, version creation/canonicalization/hashing/diff, append-only enforcement + triggers, audit hash chain + timeline UI, outbox events, status API, comments (threading), audit export.
**Exit:** FR-5, FR-8, FR-11 core; chain-verification job runs in CI/nightly.

### M3: Parties, invitations & review (M)
Party management, invitation issuance/redemption, guest scoped sessions, guest view/comment, PARTY_VIEWED tracking, approvals (electronic acceptance), approval policy, negotiation loop (propose version → review → approve), diff UI for guests.
**Exit:** FR-6, FR-7; journeys J2 (pre-signing), J3 (pre-signing) demoable.

### M4: Signing, finalization & documents (L)
Signature orchestration (parallel/sequential), OTP + session signing with consent capture, signature records + payload hashes, `finalize()` transaction, PDF rendering pipeline (HTML template → Playwright PDF, golden-file tests), rendered artifact hashing + storage, download audit, evidence pack, QR generation.
**Exit:** FR-10, FR-13; full J1 happy path through PDF.

### M5: Verification & public surface (S)
Public verify page (no-auth shell), verify API with rate limits, verification records + audit, QR resolution, offline hash-prefix check, "upload to verify" deferred to v1.1.
**Exit:** FR-12; journey J5; independent chain-verify script passes on sample data.

### M6: Reminders & notifications (M)
Notification service + in-app center + email templates, reminder rules + scheduler (pending signatures, expiries), status scheduler (EXPIRING/EXPIRED), preferences, dedupe/dead-letter dashboards.
**Exit:** FR-14; journey J6.

### M7: AI assistance (M)
AI gateway + provider adapters + structured-output validation + provenance guards + prompts (extract/explain/gaps/questions/summarize), suggestion accept/reject UX with chips + disclaimer, AI audit + budgets + org toggle, ai_interaction storage, red-team tests for fabrication/prompt-injection.
**Exit:** FR-9; journeys J1 step 3–4, J7; guardrail test suite green.

### M8: Hardening, a11y & polish (M)
WCAG 2.1 AA pass (focus on create/sign/verify), mobile flows, performance budgets, load test (1k concurrent), security review vs. §17 checklist + threat model, E2E suite (J1–J5) in CI, backup/restore drill, docs (ADR + runbooks), onboarding/disclaimer copy review.
**Exit:** production-ready checklist signed off.

### M9: Launch ops (S)
Staging → prod deploy, monitoring/alerts, DNS/TLS, abuse controls on public verify, admin category tooling for first "new category without code change" proof, v1.1 backlog seeded (OAuth, Ed25519 attestation, amendment flow, admin UI).

**Deferred (explicitly out of v1):** native mobile apps, real-time collaborative editing (OT/CRDT), advanced eIDAS/QES signatures, multi-language content templates, marketplace templates, payments/billing, white-label.

---

---

# IMPLEMENTATION BLUEPRINT

*The single-page specification for subsequent implementation stages.*

## Product truth
AgreementHub = lifecycle platform for structured agreements (draft → negotiate → sign → verify → manage), **not** a PDF generator and **not** a legal-advice provider. Excluded categories enforced in domain guard: titles/land, wills, POA, court docs, regulated finance, registrable documents. UI/copy distinguishes: document generation · electronic acceptance · electronic signature · verification · legal advice (never offered), with standing disclaimer in AI panels, finalization, footer, PDFs.

## Stack (fixed)
React+TS+Vite+TanStack Query / Node+TS+Fastify modular monolith / PostgreSQL 16 (UUIDv7 PKs, JSONB snapshots, append-only triggers) / Redis (sessions, limits, BullMQ) / S3-compatible storage / Playwright PDF / `qrcode` / pnpm+Turborepo / Vitest+Supertest+Playwright / Docker Compose dev / OpenAPI-generated shared contracts (zod).

## Modules (boundaries enforced by lint)
`identity` · `organizations` · `templates` · `agreements` (parties, sections, fields, comments, lifecycle) · `versions` · `signatures` (approvals, signing, finalize) · `audit` · `documents` (render, QR) · `verification` · `notifications` · `ai` (gateway + prompts) · `attachments`. Each owns its tables; cross-module = service interfaces + domain events via **transactional outbox**.

## Data essentials
- `agreement.public_id = AGR-<ISO>-<YYYY>-<NNNNNN>` from per-year locked counter; UUIDv7 internal.
- `agreement_version`: immutable snapshot (content JSONB), `document_hash` SHA-256 of **canonicalized JSON**, `previous_version_id`, `change_summary`, status; DB blocks UPDATE of FINAL; exactly one FINAL per agreement.
- `agreement_field.provenance ∈ {USER_PROVIDED, AI_SUGGESTED_CONFIRMED, COMPUTED}`, persisted provenance.
- `audit_event`: per-agreement `seq` + `prev_hash`/`event_hash` hash chain; INSERT-only; synchronous with domain change via outbox.
- `signature`: payload = {publicId, versionNo, docHash, signer, ts, nonce, consentVersion} → `signature_payload_hash`; method SESSION|EMAIL_OTP; IP/UA stored.
- `verification_record` + public page exposes metadata only.
- Template architecture: `category → template (versioned) → template_section → template_field`; new category = row + i18n keys.

## Lifecycle (single transition service)
`DRAFT→REVIEW→NEGOTIATION→AWAITING_SIGNATURES→ACTIVE→EXPIRING→EXPIRED`; terminal `CANCELLED|TERMINATED|REJECTED`. Declarative transition table with guards (required fields, approvals, signatures, reasons). Scheduler drives EXPIRING/EXPIRED. Invalid transition = typed error.

## Signing flow
approvals satisfy policy → SIGNATURE_REQUESTED → parallel/sequential signing (OTP for guests) → single `finalize()` tx: FINAL version + seal + finalized_at + verification record + QR + notify + audit. Post-sign changes only via new version/amendment; original stays sealed.

## API
`/api/v1` REST, RFC7807 errors, cursor pagination, idempotency keys on side-effect POSTs, sessions (Redis cookie) + CSRF, `resolveAgreementAccess` interceptor on every agreement route (org → party role → status), OpenAPI from route schemas. Public: `POST /public/verify`, `GET /verify/:publicId` (rate-limited, uniform NOT_FOUND).

## AI (assistive only)
One gateway module; versioned prompts; structured JSON output; validators require `source ∈ {USER_INPUT, TEMPLATE_BASELINE}` and drop any name/price/date/address/obligation not present in inputs; suggestions are **never auto-committed**, explicit Accept stores `AI_SUGGESTED_CONFIRMED`; UI chips USER-PROVIDED vs AI-SUGGESTED + disclaimer; timeouts/circuit-breaker/budgets/org toggle; `ai_interaction` table separate from agreement data; audit `AI_ASSISTED`; AI never actor of domain events.

## Notifications
Outbox → notification rules → in-app row + BullMQ email. Reminders: signature T+3d→3d cap 5; expiry −30/−7/−1d; manual reminder rate-limited; dedupe keys; per-type preferences (security non-disableable); i18n templates.

## Security baseline
Argon2id, verified email, OTP (TTL/single-use/rate-limited), optional TOTP MFA, guest magic links (single-agreement scope); deny-by-default authz + org-scoping in repos + IDOR test suite; CSP/HSTS/CSRF; rate limits (auth/API/verify); upload allowlist+AV+signed URLs; no PII in logs; encrypted backups; DB immutability on versions/audit/signatures; AI prompt-injection hygiene; admin break-glass audited.

## Verification story
Finalization stores hash; QR → public page shows ID/Status/Version/Created/Finalized/Integrity only; every check → record + DOCUMENT_VERIFIED audit; offline: ID + 12-char hash prefix on printed footer.

## Folder structure
As §18: `apps/web`, `apps/api` (modules + workers), `packages/{contracts,domain,template-schema,config}`, `db/{migrations,seeds}`, `e2e`, `infra/{docker,ci,deploy}`, `docs/{SPEC,adr}`.

## Build order (milestones with exit criteria)
**M0** foundations/auth/orgs/RBAC → **M1** templates+drafting+public IDs → **M2** versioning+audit chain+lifecycle+comments → **M3** invitations+guests+approvals+negotiation → **M4** signing+finalize+PDF+QR → **M5** public verification → **M6** notifications+reminders+expiry scheduler → **M7** AI gateway+guardrails → **M8** a11y/mobile/perf/security/E2E hardening → **M9** launch ops. Out of v1: native apps, realtime co-editing, QES/eIDAS-qualified signatures, payments, template marketplace.

## Definition of done (every feature)
Typed contract + unit test · permission negative tests · audit event emitted · i18n key · a11y pass · mobile pass · disclaimer compliance where user-facing · ADR if architectural.
