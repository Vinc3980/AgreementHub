# AgreementHub: Post-Implementation Security & Quality Audit (Phase 9)

Date: 2026-11-05
Scope: the nine audit phases requested after the initial implementation
(email verification, version-bound signatures, email OTP signing, PDF/QR
integrity, security hardening, email/reminders, admin console, tests, report).

This report records what was found, what was changed, what was verified, and
what remains unverified. It does not claim coverage that was not exercised.

---

## 1. Constraints honoured

- No rewrite and no architecture change: Fastify + PostgreSQL + Next.js remain
  in place; the existing domain/services/routes structure was extended.
- No feature removed and no existing agreement, version, signature or finalized
  PDF was modified. Schema changes are additive and backward compatible;
  legacy rows keep working and are labelled honestly (see §3.4).
- No unnecessary runtime dependency was added. SMTP uses `nodemailer`, which
  was already required by the existing stack; the scheduler, CORS/CSRF and
  outbox logic are dependency-free.
- Email is never sent inside an open business transaction: messages are queued
  in the same transaction and delivered by the outbox worker after commit.

---

## 2. Summary of results

| Gate | Result |
| ---- | ------ |
| API test suite | **219 / 219 passed** in 21 files (`npm test`, sequential DB-backed) |
| New audit suites | email verification, version-bound signatures, email OTP, PDF/QR integrity, scheduler/outbox, admin permissions |
| TypeScript | `npm run typecheck` clean (api, domain, contracts, db, web) |
| Production build | `npm run build` succeeded (Next.js 16.4.0, 15 routes) |
| Dev database | migrations `0006`, `0007`, `0008` applied |
| Browser smoke test | login, admin gating + admin console, notification preferences, public verification with matching and mismatching `pdfHash` |

---

## 3. Findings and corrections

### 3.1 Email verification (Phase 1)

**Found**
- Registration set `email_verified_at` automatically, so the address was
  "verified" before the user ever proved control of it.
- Invitations could be accepted by any signed-in account holding the link,
  regardless of the invited address.

**Corrected**
- Added `email_verification_tokens` (`0006`): 256-bit random token, stored only
  as SHA-256, 24-hour expiry, single active token per user, `used_at` consumed
  exactly once.
- Verification email is delivered through the outbox; the API never returns the
  raw token. Resend is limited to one per 60 seconds and invalidates the previous
  link.
- Invitation acceptance now requires the signed-in account's email to be
  verified and to match the invited address (`403 EMAIL_NOT_VERIFIED`).
- The web app gained `/verify-email` (token consumption with success/error
  states) and a non-blocking "email not verified" banner with a resend action.

### 3.2 Version-bound signatures and amendments (Phase 2)

**Found**
- Signature checks were agreement-wide; a signature on an old version could
  satisfy a newly amended version.

**Corrected**
- Required signers, signature uniqueness and finalization are evaluated against
  the **current version id**, not the agreement alone.
- Starting an amendment creates a new version and re-notifies every required
  party (in-app + email); signatures from prior versions no longer count.
- Finalization validates the current version and refuses to seal with missing
  current-version signatures.
- Regression suite: `version-signatures.test.ts` (v1 signatures cannot satisfy
  v2, notification fan-out, archived immutability, superseded-version rejection,
  cross-agreement isolation).

### 3.3 Email OTP signing (Phase 3)

**Found**
- The documented `EMAIL_OTP` method had no real challenge; there was no proof
  that the signer controlled the email address.
- A session-only signature could be presented as "verified" without evidence.

**Corrected**
- Added `signature_otps` (`0007`) and `signatureOtp.ts`: six digits from
  `crypto.randomInt`, SHA-256 storage, 10-minute TTL, single use, 5 attempts,
  60-second resend cooldown and one active OTP per (version, party).
- The OTP is bound to agreement + version + party + signer email; requesting or
  consuming with a different version/party/email fails.
- Signatures record the method, identity assurance, version, document hash,
  timestamp, consent version and request metadata. `EMAIL_OTP_VERIFIED` is set
  only after a code is successfully consumed; typed/drawn/consent signatures
  record `AUTHENTICATED_SESSION` and are never described as independently
  verified.
- `POST /signatures/otp` requests a code. The code is never returned by the API.
- Regression suite: `signature-otp.test.ts` (delivery, wrong code, no false
  assurance, single use, expiry, lockout, binding, resend rate limit).

### 3.4 PDF, content and signature integrity + QR (Phase 4)

**Found**
- Verification checked a derived hash but did not independently verify the
  **stored finalized PDF bytes**, and the QR link carried no document digest.
- Signature verification could only compare against live data, so a changed
  signature record was not detectable; there was no honest state for legacy
  records that predate snapshots.

**Corrected**
- Verification now performs three independent checks: canonical content hash,
  actual stored finalized PDF bytes, and every signature record's payload
  snapshot.
- Finalization stores the generated PDF's SHA-256 on the version; verification
  re-hashes the stored bytes and compares. The QR/verification URL carries
  `?pdfHash=`, and a caller-supplied digest is compared to the registered one.
- Public verification exposes only safe metadata (public id, category, status,
  version, timestamps, hashes). It returns **UNVERIFIED** for legacy signatures
  without a snapshot instead of a false pass or a false alarm.
- Regression suite: `pdf-integrity.test.ts` (byte verification, QR match and
  mismatch, replaced PDF detection, signature snapshot tampering, legacy
  `UNVERIFIED`, separate check results, generated digest equality).

### 3.5 Security middleware and authorization (Phase 5)

**Found**
- Security middleware existed but was unused/incomplete; CORS and resident
  headers were not consistently applied, and proxy trust was implicit.
- Some endpoints relied on UI gating rather than server-side authorization.

**Corrected**
- Rewrote `plugins/security.ts` and registered it: explicit CORS allowlist
  (`WEB_ORIGIN` + `CORS_ORIGINS`), origin-based CSRF protection for
  cookie-authenticated state changes, and hardening headers (no sniff,
  frame-deny, referrer policy, permissions policy, HSTS in production).
- `TRUST_PROXY` is explicit and defaults to `false`, so `X-Forwarded-*` is not
  trusted without a proxy.
- Reviewed private routes for server-side membership/party/role checks and
  IDOR behaviour (404 rather than 403 where required); SQL access stays
  parameterized; stored HTML/PDF rendering keeps escaping and storage paths
  private; AI prompts remain read-only and confirmation-gated.
- Audit and signature/version/platform-audit tables remain append-only through
  DB triggers.

### 3.6 Email abstraction, reminders and scheduling (Phase 6)

**Found**
- Emails (when present) were sent inline, with no retry, no delivery record and
  no duplicate suppression.
- There was no expiry transition/reminder or signature-reminder job.

**Corrected**
- Added `email_outbox` and `email.ts`/`outbox.ts`: transports `console`,
  `smtp`, `memory` (tests) and `disabled`; unique dedupe key; lease-based claim
  with `FOR UPDATE SKIP LOCKED`; exponential backoff (`EMAIL_RETRY_MAX`);
  retention cleanup (`EMAIL_RETENTION_DAYS`).
- Messages cover invitation, verification, password reset, signature request,
  agreement completion, expiry warning/expired, signature reminder and the
  signing OTP.
- Added an in-process scheduler (`SCHEDULER_INTERVAL_MS`, default 5 min;
  `0` disables) driving `ACTIVE → EXPIRING → EXPIRED`, the expiry reminder
  ladder (`EXPIRY_WARN_DAYS`), signature reminders
  (`REMINDER_SIGNATURE_INTERVAL_DAYS` / `REMINDER_SIGNATURE_MAX`), outbox
  delivery and cleanup. Ticks are serialized with an advisory lock; reminders
  carry dedupe keys so re-running a tick never duplicates a message.
- Notification preferences (`reminders`, `comments`, `activity`, `email`) are
  honoured; essential messages (`PARTY_INVITED`, `APPROVAL_REQUESTED`,
  `SIGNATURE_REQUESTED`) cannot be disabled and intentionally bypass the email
  channel switch.
- Owners can send one manual reminder per signer per hour via
  `POST /agreements/:id/remind`; it is capped at 5, throttled and audited as
  `REMINDER_SENT`.
- Regression suite: `scheduler.test.ts` (expiry sweep once, reminder ladder,
  preference suppression, manual reminder throttle, out-of-state refusal,
  idempotent outbox, no inline send inside a transaction).

### 3.7 Platform administration (Phase 7)

**Found**
- There was no protected platform-admin surface; template editing could have
  mutated what agreements referenced.

**Corrected**
- Added `users.is_platform_admin` and `platform_audit_events` (append-only
  trigger). Bootstrap is possible via `PLATFORM_ADMIN_EMAILS` at registration,
  with the DB flag preferred in production.
- Added the admin API and `/admin` console: user search/suspension (sessions
  revoked) and reactivation, template drafts/publish/retire, version history,
  category enable/disable, statistics, email-queue/notification counters and
  activity.
- Publishing is explicit `DRAFT → PUBLISHED → RETIRED`; publishing a version
  retires the prior published version of the same category + name. Published
  and retired rows are immutable; any change creates a new version row.
  Finalized agreements keep their frozen version snapshots.
- Ordinary users are refused by every admin endpoint (server-side), the nav
  link is hidden, the page shows an access-required state, and the last
  administrator cannot demote or suspend themselves.
- Regression suite: `admin.test.ts` (ordinary-user refusal, statistics/user
  search, suspension + session revocation, self/last-admin protection,
  category visibility, immutable published versions, append-only admin audit).

### 3.8 Defects found while running the audit tests (fixed)

- Three SQL cooldown/throttle queries had one missing closing parenthesis
  (email-verification resend, signing-OTP resend, scheduler manual/expiry
  throttling), producing `500` responses. Corrected and re-tested.
- Expiry reminders computed "days left" in JavaScript from a database
  timestamp; millisecond clock skew could round a 3-day agreement to 4 and skip
  the warning window (reproduced only in the full suite). The day count is now
  computed inside PostgreSQL so selection and filtering use the same clock.
- `notify()` now returns whether a notification row was actually inserted;
  scheduler/manual-reminder counters and audits only count real deliveries,
  so preference suppression does not inflate metrics.
- The admin template form's "minimal definition" was empty and failed
  validation; it now ships a valid editable section/field skeleton.

---

## 4. Database migrations

| Migration | Purpose |
| --------- | ------- |
| `0006_email_verification.sql` | Hashed, expiring, single-use verification tokens; one active token per user |
| `0007_signature_otps.sql` | Hashed, expiring, single-use signing OTPs bound to agreement/version/party/email |
| `0008_security_audit.sql` | Signature snapshot/assurance/request id, verification check columns, notification preferences, platform admin flag, `email_outbox`, `platform_audit_events` + append-only trigger |

All three are additive. `0006` deliberately does **not** retroactively unset
verification for already-registered users (that would lock them out); only new
registrations start unverified.

The automated suite rebuilds the test schema from `db/migrations` + `db/seeds`
on every run, so the migrations were exercised by the 219 tests. They were also
applied to the dev database (`npm run db:migrate`).

---

## 5. Main files changed / added

**API**
`src/config.ts`, `src/app.ts`, `src/main.ts`, `src/plugins/security.ts`,
`src/db.ts` (helpers), `src/routes/auth.ts`, `src/routes/signatures.ts`,
`src/routes/verification.ts`, `src/routes/documents.ts`,
`src/routes/agreements.ts`, `src/routes/admin.ts` (new),
`src/services/email.ts` (new), `src/services/outbox.ts` (new),
`src/services/emailVerification.ts` (new), `src/services/signatureOtp.ts` (new),
`src/services/scheduler.ts` (new), `src/services/admin.ts` (new),
`src/services/verification.ts`, `src/services/signatures.ts`,
`src/services/notifications.ts`, `src/services/accounts.ts`,
`src/services/parties.ts`, `src/services/pdf.ts`, `src/services/render.ts`,
`src/services/storage.ts`, `src/services/identity.ts`,
`src/services/documentHtml.ts`.

**Packages / DB**
`packages/contracts/src/index.ts`, `packages/domain/src/audit.ts`,
`db/migrations/0006`–`0008`.

**Web**
`src/lib/types.ts`, `src/lib/format.ts`, `src/components/layout/nav.tsx`,
`src/components/ui/verify-qr.tsx`,
`src/app/(app)/layout.tsx` (unverified banner),
`src/app/(app)/admin/page.tsx` (new),
`src/app/(app)/settings/page.tsx` (notification prefs + resend verification),
`src/app/(auth)/verify-email/page.tsx` (new),
`src/app/(auth)/forgot-password/page.tsx`,
`src/app/(auth)/reset-password/page.tsx`,
`src/app/(auth)/login/page.tsx`,
`src/app/verify/[publicId]/page.tsx` (three-way integrity + `pdfHash`),
agreement detail tabs/dialogs.

**Tests**
`test/email-verification.test.ts`, `test/version-signatures.test.ts`,
`test/signature-otp.test.ts`, `test/pdf-integrity.test.ts`,
`test/scheduler.test.ts`, `test/admin.test.ts` (all new), plus updates to the
existing harness and affected suites.

**Docs/config**
`README.md`, `.env.example`, this report.

---

## 6. Verification performed

### 6.1 Automated

```text
npm test --workspace @agreementhub/api
  Test Files  21 passed (21)
  Tests       219 passed (219)

npm run typecheck
  tsc -p apps/api && tsc -p packages/domain && tsc -p packages/contracts
  && tsc -p db && tsc -p apps/web        # clean

npm run build
  Next.js 16.4.0 production build        # succeeded, 15 routes
```

New suites and what they exercise are listed in §3.2–§3.7.

### 6.2 Browser smoke test (dev servers, PostgreSQL)

- Signed in at `/login` with the existing demo owner account.
- Visited `/admin` as an ordinary user: server-data page showed
  "Administrator access required" (no admin UI leak).
- Temporarily granted `is_platform_admin` to that account in the dev DB,
  reloaded `/admin`: overview statistics rendered and the Templates tab loaded
  the published-version table; the flag was then reverted to `false`.
- Opened `/settings` → Notifications: the four preference switches render with
  their current values.
- Opened `/verify/AGR-GH-2026-000017?pdfHash=<registered digest>`:
  "Verified", with separate canonical content, finalized PDF bytes and
  signature-record results (legacy signatures correctly shown as
  "snapshot unavailable" rather than verified).
- Opened the same URL with an all-zero digest: "Integrity check failed" with the
  finalized-PDF-bytes reason and the registered digest prefix.
- Confirmed both dev servers start with the new `trustProxy`, security plugin,
  scheduler and email transport configuration.

Not exercised manually: registration → verification email click-through (the
token is only in the outbox/email capture), real SMTP delivery, and creating a
template through the admin form (covered by API tests, form skeleton validated
by typecheck/build).

---

## 7. Remaining limitations and recommendations

1. **Real email delivery is unverified.** The default transport is `console`
   and tests use `memory`. A production deployment must set `EMAIL_TRANSPORT=smtp`
   with real `EMAIL_SMTP_*` credentials and configure SPF/DKIM; only then can
   deliverability and provider-specific behaviour be claimed.
2. **OTP proves control of the email address, not legal identity.** The label
   `EMAIL_OTP_VERIFIED` is intentionally narrow; typed/drawn/consent signatures
   are `AUTHENTICATED_SESSION` and are displayed as such.
3. **Legacy signatures remain `UNVERIFIED`.** Records created before the payload
   snapshot cannot be retroactively proven intact. They are reported as
   unverified, never as passing.
4. **The scheduler is in-process.** A PostgreSQL advisory lock prevents
   concurrent ticks, and the outbox claim is safe across instances, but a
   multi-instance deployment should disable the timer on all but one instance or
   move the schedule to an external job runner. There is no retry/dead-letter
   queue beyond `EMAIL_RETRY_MAX`.
5. **No third-party penetration test or load/performance test** was performed.
   The audit covered code-level authorization, injection, CSRF/CORS, headers,
   IDOR, rate limiting, storage privacy and audit immutability, not runtime
   exploitation at scale.
6. **Next.js security advisory is still open.** The installed Next.js 16.4.0
   reports a known vulnerability; the security upgrade was declined during this
   audit, so the build prints the advisory. This should be scheduled separately
   (see §8).
7. Admin UI is intentionally minimal (no bulk actions or pagination on every
   list); API behaviour is tested, but large-dataset UX was not.

---

## 8. Next.js advisory

The production build and dev server both report:

> Your version of Next.js is affected by a known security vulnerability.
> We strongly recommend you upgrade Next.js.

The recommended command from the tooling is:

```text
next upgrade --agent=security
```

This was intentionally not run during the audit because the upgrade was
declined. Track it as a separate dependency-upgrade task.
