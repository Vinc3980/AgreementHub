# AgreementHub

Secure digital agreement platform. Full stack.

AgreementHub lets organizations draft agreements from templates, negotiate versions,
collect approvals and electronic signatures, and publish tamper-evident verification
links. Every state change is recorded in an append-only, hash-chained audit trail, and
finalized documents are sealed with a content hash anyone can verify.

This repository contains the **backend** (PostgreSQL schema, domain services, REST API,
automated test suite) and the **frontend** (Next.js 16 App Router, responsive SaaS UI
covering the complete agreement lifecycle).

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Backend stack: Node.js + TypeScript + Fastify 5, PostgreSQL 17, zod, Argon2id, vitest
- Frontend stack: Next.js 16 (App Router, Turbopack), React 19, Tailwind CSS v4,
  TanStack Query 5, lucide-react

---

## Requirements

| Tool    | Version   |
| ------- | --------- |
| Node.js | ≥ 20 (tested on 24) |
| npm     | ≥ 10      |
| PostgreSQL | ≥ 14 (tested on 17) |

No Docker required. The app connects to any reachable PostgreSQL instance.

---

## Quick start

```powershell
# 1. Install dependencies (npm workspaces)
npm install

# 2. Configure
Copy-Item .env.example .env      # adjust DATABASE_URL if needed

# 3. Create the databases (once) and a role
psql -U postgres -c "CREATE ROLE agreementhub LOGIN PASSWORD 'agreementhub';"
psql -U postgres -c "CREATE DATABASE agreementhub OWNER agreementhub;"
psql -U postgres -c "CREATE DATABASE agreementhub_test OWNER agreementhub;"

# 4. Apply migrations and seed templates/categories
npm run db:migrate
npm run db:seed

# 5. Run the API (http://127.0.0.1:3000)
npm run dev

# 6. In a second terminal, run the web app (http://127.0.0.1:3001)
npm run dev:web

# 7. Verify everything works
npm test          # 219 automated tests
npm run typecheck
```

Open <http://127.0.0.1:3001>. Register an account, complete onboarding, and run the
full lifecycle: create a draft from a template, submit for review, request approvals,
invite counterparties, sign, finalize, then verify and download the sealed document.

> The web app talks to the API through a same-origin rewrite (`/api/:path*` →
> `API_ORIGIN`, default `http://127.0.0.1:3000`), so the httpOnly session cookie works
> without any CORS setup.

> The test suite needs `TEST_DATABASE_URL` (defaults to
> `postgres://agreementhub:agreementhub@127.0.0.1:5432/agreementhub_test`).
> It **drops and rebuilds the `public` schema of that database on every run**, so never
> point it at a database whose name does not contain `test`; `global-setup.ts` refuses.

### npm scripts

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start the API with hot reload (`tsx watch`)    |
| `npm run dev:web`   | Start the Next.js web app (port 3001)          |
| `npm test`          | Run the vitest suite (sequential, DB-backed)   |
| `npm run typecheck` | `tsc` across all workspaces (incl. web)        |
| `npm run build`     | Typecheck + production build of the web app    |
| `npm run db:migrate`| Apply pending SQL migrations                   |
| `npm run db:seed`   | Seed template categories and agreement templates |
| `npm run db:reset`  | Drop, re-migrate, and re-seed the dev database |

---

## Repository layout

```
AgreementHub/
├── docs/SPEC.md               # Authoritative specification
├── db/
│   ├── migrations/            # Normalized schema + immutability/append-only triggers
│   ├── seeds/                 # Template categories + agreement templates
│   ├── migrate.ts             # Migration runner
│   └── seed.ts / reset.ts
├── packages/
│   ├── domain/                # Pure domain logic (no I/O)
│   │   ├── lifecycle.ts       # Status transition matrix + actor rules
│   │   ├── version.ts         # Version status rules, diffing
│   │   ├── hash.ts            # SHA-256 canonical document hashing
│   │   ├── audit.ts           # Audit event registry + chain verification
│   │   └── publicId.ts        # AGR-GH-2026-000001 style public IDs
│   └── contracts/             # zod request/response schemas (API contract)
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── main.ts / app.ts   # Fastify bootstrap
│   │   │   ├── config.ts          # Env config (zod-validated, fail-fast)
│   │   │   ├── plugins/           # Error handler (RFC 7807), auth, rate limits
│   │   │   ├── services/          # Domain services (agreements, versions, signatures…)
│   │   │   └── routes/            # REST endpoints by domain
│   │   └── test/                  # vitest suites + harness
│   └── web/                       # Next.js 16 frontend (port 3001)
│       └── src/
│           ├── app/               # Routes: (auth), (app) shell, verify/[publicId]
│           ├── components/        # UI kit + agreements/dashboard composites
│           └── lib/               # api client, session, queries, action-rules
```

---

## API overview

Base path: `/api/v1`. Authentication: `Authorization: Bearer <token>` (or the
`ah_session` httpOnly cookie set at login). Errors are RFC 7807 `application/problem+json`
with a stable machine-readable `code`.

| Area | Endpoints |
| ---- | --------- |
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `POST /auth/logout-all` · `GET /auth/session` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/change-password` · `GET /auth/sessions` · `DELETE /auth/sessions/:id` |
| Users | `GET /users/me` · `PATCH /users/me` (incl. `completeOnboarding`) |
| Agreements | `POST /agreements` · `GET /agreements` · `GET /agreements/:id` · `PATCH /agreements/:id` · `GET /agreements/:id/versions` · `POST /agreements/:id/status` · `POST /agreements/:id/cancel` · `POST /agreements/:id/terminate` · `POST /agreements/:id/amendments` · `GET /agreements/:id/audit` · `GET /agreements/:id/audit/export` (CSV) |
| Versions | `POST /versions` · `GET /versions/:id` · `GET /versions/:id/diff/:otherId` |
| Parties | `POST /agreements/:id/parties` · `GET /agreements/:id/parties` · `POST /parties/accept-invitation` |
| Approvals | `POST /approvals/request` · `POST /approvals` |
| Signatures | `POST /signatures` (methods: `TYPED` · `DRAWN` · `CONSENT` · `SESSION` · `EMAIL_OTP`) · `POST /signatures/request` · `GET /agreements/:id/signatures` · `GET /agreements/:id/signature-status` · `POST /agreements/:id/finalize` |
| Documents | `GET /agreements/:id/documents/:versionNumber/download` (HTML) · `GET /agreements/:id/documents/:versionNumber/preview` (inline HTML, `DRAFT: NOT FINAL` / `FINAL AGREEMENT`) · `GET /agreements/:id/documents/:versionNumber/pdf` (generated draft / hash-verified stored final) |
| Dashboard | `GET /dashboard` (KPI counts, pending actions, recent activity) |
| Comments | `GET /comments` · `POST /comments` · `PATCH /comments/:id` (status OPEN/RESOLVED) |
| Suggestions | `GET /agreements/:id/proposals` · `POST /proposals` · `POST /proposals/:id/decide` (accept/reject) |
| Templates | `GET /templates` · `GET /templates/categories` · `GET /templates/:id` · `POST /agreements/:id/template/preview` · `POST /agreements/:id/template/generate` |
| AI assistant | `POST /ai/extract` · `POST /agreements/:id/ai/review` · `POST /agreements/:id/ai/explain` · `POST /agreements/:id/ai/summary` · `POST /agreements/:id/ai/questions` (all authenticated, **read-only**) |
| Notifications | `GET /notifications` · `POST /notifications/:id/read` · `POST /notifications/read-all` |
| Verification | `GET /verification/:publicId` **(public, no auth)** · `POST /verification` |

### Template engine

Templates are **data, not code**: each row in `agreement_templates` stores a
`content_schema` definition that the engine evaluates, no UI or backend change
is needed to add a template or category (SPEC FR-2.4):

```jsonc
{
  "definitionVersion": 1,
  "sections": [
    { "code": "deposit", "title": "Security Deposit", "order": 5,
      "guidance": "Shown only when a deposit is collected.",
      "showIf": { "field": "deposit_required", "equals": "Yes" },
      "body": "Deposit: the Tenant pays {{field:deposit_amount}} …" }
  ],
  "fields": [
    { "code": "deposit_amount", "label": "Deposit amount", "type": "money",
      "required": true, "group": "Deposit",
      "showIf": { "field": "deposit_required", "equals": "Yes" },
      "guidance": "Numbers only (e.g. 1200)." }
  ]
}
```

- **Field types**: `text · textarea · number · money · date · email · select · toggle`;
  fields carry `required`, `options`, `guidance`, `placeholder`, `group`, `default`,
  and an optional one-level `showIf` condition (e.g. `maintenance = Yes → maintenance
  terms`, `payment schedule = Custom → custom schedule builder`).
- **One evaluator everywhere**: the pure engine lives in
  `packages/domain/src/template.ts` (`@agreementhub/domain/template`) and is used by
  the API (generation, validation gates) and the web UI (dynamic forms, live preview)
  alike.
- **Draft generation**: `POST /agreements/:id/template/preview` composes the document
  from stored values (optional unsaved `values` overlay, never persisted);
  `POST /agreements/:id/template/generate` persists values and rewrites working-copy
  section bodies with `{{field:…}}` placeholders resolved, conditional sections get
  `included` synced to their condition. Both are limited to `DRAFT`/`NEGOTIATION`
  (same guards as draft edits).
- **Validation**: required visible fields block approval requests, signature
  requests, the transition into `AWAITING_SIGNATURES`, and finalization with
  `400 MISSING_REQUIRED_FIELDS` (the UI surfaces the same list inline). Wrong-typed
  values are rejected at generation with `400 TEMPLATE_VALUES_INVALID`.
- **Output is structured plain data** (sections + field values). Rendering to HTML
  (preview, download, print) and the immutable final PDF happens in
  `services/render.ts`, decoupled from the engine.
- The five initial templates, Freelance/Service, Rental, Business Proposal, NDA,
  Client/User, ship with full definitions (fields, guidance, conditional sections)
  in `db/seeds/0001_templates.sql`; tests assert every seeded definition parses and
  that all conditions/placeholders reference defined fields.

### AI Agreement Assistant

Five assistant features behind a **swappable provider abstraction**, no API
keys ever reach the web app, and the assistant never writes to an agreement:

| Feature | Endpoint | Behaviour |
| ------ | -------- | --------- |
| 1. Plain language → fields | `POST /ai/extract` | `{ description, templateId? }` → suggested fields with confidence + basis quote, mapped onto the template's real field codes (generic slots without one) plus `needsInput` for what could **not** be derived, never invented |
| 2. Missing information | `POST /agreements/:id/ai/review` | Always headed **"Potentially missing information"**, blank required fields and uncovered topics (cancellation, ownership, dates…), never a legal verdict |
| 3. Clause explanation | `POST /agreements/:id/ai/explain` | `{ text }` or `{ sectionCode }` (body fetched server-side) → formal text beside plain language + phrase-by-phrase breakdown |
| 4. Summary | `POST /agreements/:id/ai/summary` | Parties, purpose, payment, timeline, responsibilities, termination, important dates, absent facts are stated as "not stated", never filled in |
| 5. Suggested questions | `POST /agreements/:id/ai/questions` | Neutral drafting questions (e.g. *"Who owns the website source code after payment?"*); the user decides whether to answer them in the draft |

**Safety model** (encoded in `apps/api/src/services/aiAssistant.ts`):

- Every response carries the fixed disclaimer *"AI-generated assistance. Review
  carefully. This is not legal advice."* plus `aiGenerated: true` and the
  engine label; the UI shows them on every result.
- **All `/ai/*` endpoints are read-only.** Extraction returns *suggestions*;
  applying one is the user's own `PATCH /agreements/:id` with
  `provenance: 'AI_SUGGESTED_CONFIRMED'`, the audit trail shows exactly what
  the AI proposed and the user confirmed. Finalized agreements stay immutable
  (the same DRAFT/NEGOTIATION guard as any edit) while the read-only features
  remain available for explaining them.
- Requests are logged with **metadata only** (feature, provider, model,
  latency, counts), never the description text or agreement content.

**Providers** (`apps/api/src/ai/`, chosen by `AI_PROVIDER`):

- `rules` *(default)*, deterministic, offline heuristics (currency/amount/
  payment/revisions/maintenance extraction, phrase glossary, gap analysis).
  Works with no key and only restructures what is actually present.
- `openai`, OpenAI-compatible chat completions (`OPENAI_API_KEY`,
  `OPENAI_BASE_URL`, `AI_MODEL`), strict JSON output validated server-side;
  provider failures surface as `502 AI_PROVIDER_ERROR` / `504 AI_PROVIDER_TIMEOUT`.
- A new vendor implements the four-task `AiProvider` interface
  (`apps/api/src/ai/types.ts`), framing, disclaimers, mapping, and logging
  stay in the service layer, so API shapes and safety rules never change.

The web app renders one reusable `AssistantPanel`: describe → generate fields →
per-suggestion **Accept / Edit / Reject** on the new-agreement and draft-editor
pages, plus read-only review/summary/questions/explain on the editor and the
agreement page (usable on finalized agreements).

### Core lifecycle

```
DRAFT → REVIEW → (approvals) → AWAITING_SIGNATURES → [finalize] → ACTIVE
  ↘ NEGOTIATION ↗                    ↘ CANCELLED / TERMINATED / REJECTED
                                        ACTIVE → NEGOTIATION  (amendment only)
```

- Transitions are enforced by a per-actor matrix in `packages/domain/src/lifecycle.ts`
  (plus DB status checks). Illegal jumps → `409 INVALID_TRANSITION`.
- `CANCELLED`, `TERMINATED`, `REJECTED` require a `reason`.
- A sealed (`ACTIVE`) agreement re-opens **only** through the amendment flow:
  the generic status route answers `409 AMENDMENT_REQUIRED`.

### Versioning & immutability

- The **working copy** (sections/fields/parties) is editable while `DRAFT`/`NEGOTIATION`;
  `POST /versions` freezes a snapshot (`DRAFT` version), supersedes its predecessor, and
  records a `changeSummary`.
- **Automatic versioning during negotiation**: while the agreement is `NEGOTIATION`,
  every `PATCH /agreements/:id` whose content hash actually changed creates the next
  version with a derived summary (`"Payment, scope modified"`); no-op edits create
  nothing, and while still `DRAFT` the latest `DRAFT` version is refreshed in place.
- **Template generation follows the same policy** (`POST /agreements/:id/template/generate`):
  the snapshot is re-derived from the working copy, so it can never drift, refreshed
  in place while `DRAFT`, a new version when generation changes the document during
  negotiation, and nothing at all when the rendered content is identical.
- Database triggers enforce: committed versions (`SUPERSEDED`, `PENDING_APPROVAL`,
  `APPROVED`, `REJECTED`, `FINAL`) are frozen; `FINAL` and audit rows can never be
  updated or deleted, only `DRAFT` versions refresh in place.
- The document hash is a canonical SHA-256 over title + sections + fields + parties +
  public ID + template code: same content ⇒ same hash.
- **Amendments**: `POST /agreements/:id/amendments` seeds a new working version as an
  exact copy of the sealed `FINAL` document (`Amendment to v{N}`, identical hash), keeps
  `final_version_id` pointing at the immutable final row, and audits
  `AMENDMENT_STARTED`. Public verification of the sealed document stays `VERIFIED`
  throughout the amendment.

### Negotiation, comments & suggestions

- **Version timeline**: the Versions tab shows every version as
  number · date · action (`Created` / `Payment modified` / `Finalized`) connected by
  arrows; comparing two versions lists added/removed/modified titles, sections, fields
  and parties with **word-level highlighting** (struck through = removed, green =
  added) from the shared `@agreementhub/domain/diff` helper.
- **Comments** record author, timestamp, section, content, and status
  (`OPEN`/`RESOLVED`); only the comment's author or an agreement manager may flip the
  status (`PATCH /comments/:id` → `COMMENT_STATUS_CHANGED` audit event).
- **Suggestions never edit the contract**: `POST /proposals` stores a `PENDING`
  proposal (`FIELD`/`SECTION`/`TITLE` target with current + proposed value) and only
  notifies. Accepting requires a user with edit rights and routes through the normal
  draft-update path (so during negotiation it freezes the previous version);
  rejecting changes nothing. One open suggestion per target; suggestions close once
  signatures are awaited.
- Everything is surfaced in the **Negotiation tab** (comments + suggestions with
  accept/reject), which states the invariant up front: terms change only on an
  explicit accept or a direct draft edit.

### Audit & verification

- Every significant action appends an `audit_events` row with a per-agreement `seq`,
  `prev_hash`, and `event_hash` (SHA-256 chain). `verifyAuditChain()` detects any
  forged/edited/deleted event; DB triggers block `UPDATE`/`DELETE`.
- **Event classification**: every event is classified as **user activity**,
  an **agreement event** (lifecycle/state change), or a **system event**
  (system/AI actor, automated reminders) via `auditEventCategory()` in
  `@agreementhub/domain`. The audit tab offers filter chips per class, each row
  shows a class badge, and the CSV export includes a `category` column.
  Administrators get no edit path either way.
- `POST /agreements/:id/finalize` seals the version as `FINAL`, moves the agreement to
  `ACTIVE`, and returns a `verificationUrl` (`{PUBLIC_BASE_URL}/verify/{publicId}`).
- `GET /verification/:publicId` is public and returns **metadata only**
  (id, category, status, version, dates, `integrity`, `hashPrefix`), never document
  contents, parties, comments, or audit internals. `integrity` is `VERIFIED` /
  `MISMATCH` / `NOT_FOUND`. Every check (including unknown IDs) is recorded in
  `verification_records` with a hashed requester, never the raw IP.
- **QR verification**: the Share & verify dialog and the public verification page
  render a QR code (`qrcode.react`) encoding `/verify/{publicId}`, scanning it opens
  the metadata-only page, never the document.

### Signing (MVP methods & records)

- The sign dialog offers the three MVP methods, **typed name**, **drawn signature**
  (canvas capture stored as an image data URL), and **explicit electronic
  acceptance**, each with the consent statement; `SESSION`/`EMAIL_OTP` remain
  available to API clients. Per-method payloads are validated
  (`TYPED` ⇒ `signatureText`, `DRAWN` ⇒ `signatureData`) and the method + payload
  hash are bound into `signature_payload_hash`.
- Every signature record stores agreement, version, signer, timestamp, method,
  metadata (consent version, IP/UA, data hash) and the **document hash at signing**;
  the method is clearly labelled in the sign result, the signature-records card on
  the Parties tab, and everywhere the record is displayed.
- **Completed signatures are immutable**: a DB trigger (like `audit_events`) blocks
  `UPDATE`/`DELETE` on `signatures` for everyone, records can be added, never altered.

---

### Document generation (HTML → PDF → hash → storage → verification)

- **One renderer everywhere**: `services/render.ts` produces the canonical HTML
  for preview, HTML download, browser print, and the final PDF, professional
  layout (brand header, Agreement ID / version / category / effective-date meta
  grid, numbered sections, key-terms and parties tables, per-party **Provider /
  Client signature blocks** with Name · Signature · Date rows and the signing
  method, identity footer with the full SHA-256 hash and verification URL) with
  A4 `@page` rules, page-break control, and a per-page footer (`ID · version ·
  page x of y`) in the PDF.
- **Draft vs. final labelling**: previews and draft PDFs are labelled
  `DRAFT: NOT FINAL` (banner + per-page watermark); finalized documents are
  labelled `FINAL AGREEMENT`. The document tab shows the same status badge.
- **Immutable final PDF**: `POST /agreements/:id/finalize` generates the PDF
  inside the same transaction (via headless Chromium, system Edge/Chrome through
  `puppeteer-core`, all network requests from the document blocked), stores it
  under `STORAGE_DIR`, records its **SHA-256 against the final version** in the
  append-only `generated_documents` table (DB trigger blocks `UPDATE`/`DELETE`),
  and emits a `DOCUMENT_GENERATED` audit event. A finalization without its PDF
  simply does not finalize.
- **Storage is private**: no storage path or URL is ever returned by the API;
  bytes stream only through the authenticated, access-checked document routes.
  Stored final PDFs are re-hashed on **every** download and refused with
  `409 DOCUMENT_HASH_MISMATCH` if the bytes diverge; drafts are rendered
  ephemerally and never persisted, so the pipeline cannot overwrite a finalized
  document (write-once `O_EXCL` storage keys).
- **Backfill**: final versions sealed before the pipeline existed generate and
  store their PDF once on first download, then serve the stored bytes forever.
- **Printing**: the in-app *Preview document* modal renders the exact document
  (Print button drives the browser print dialog; `@media print` CSS drops
  chrome), and printed output retains Agreement ID, version, dates, signatures,
  and the document hash.
- `PDF_GENERATION=off` disables generation (stored finals still serve; drafts
  answer `503 PDF_UNAVAILABLE`); `PDF_BROWSER_PATH` points at a specific browser.

---

## Security model

- **Passwords**: Argon2id (`$argon2id$v=19,m=19456,t=2,p=1`).
- **Sessions**: opaque tokens; only the SHA-256 hash is stored. Returned once at
  login/register, then via httpOnly `SameSite=Strict` cookie or `Authorization: Bearer`.
- **Authorization**: deny-by-default. Membership + party-role checks per agreement;
  invisible resources return `404` (no IDOR oracle), insufficient role returns `403`.
- **Invitations**: raw token shown once; only its hash is persisted; single-use with
  expiry.
- **Validation**: all request bodies parsed with zod → `400 VALIDATION_FAILED` with
  field errors.
- **Rate limiting**: global + stricter per-route budgets on auth and verification
  (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`; disabled when `RATE_LIMIT_MAX=0`, which the
  test harness sets).
- **Errors**: RFC 7807 problem+json; never leaks stack traces, SQL, hashes, tokens, or
  audit internals.
- **Document storage**: files live under `STORAGE_DIR` (server-side only) and are
  reachable exclusively through the authenticated document routes; stored final
  PDFs are verified against their recorded hash on every download, the PDF
  renderer runs with an isolated browser profile and blocks all network requests
  from the rendered document, and `generated_documents` rows are append-only.

---

## Testing

```powershell
npm test
```

- 21 suites / 219 tests covering: authentication, authorization (IDOR, roles),
  agreement creation & access, version creation & immutability (incl. DB triggers),
  invitation workflow, audit chain (incl. forged-event detection + event
  classification and the CSV `category` column), status transitions,
  signature state machine + MVP signing methods (typed/drawn/consent payloads,
  method binding, signature-record immutability via DB trigger), verification
  hash checks (incl. tamper detection and the public category projection), account
  management (profile, forgot/reset/change password, session list & revocation),
  the dashboard summary endpoint, the template engine (seed integrity,
  conditional evaluation, document generation, finalization gates), the AI
  assistant (auth, extraction mapping, read-only guarantees, confirmation via
  `AI_SUGGESTED_CONFIRMED`, finalized-agreement immutability, disclaimers),
  negotiation & version management (auto-versioning per change, no-op edits create
  nothing, generation keeps snapshots in sync, comment status + permissions,
  suggest → accept/reject with the "never auto-changes terms" guarantee, amendment
  seeding with the final version staying sealed, word-diff round-trip), and the
  document pipeline (draft/final preview labels + access control, real PDF
  generation with magic-byte checks, finalization recording the PDF hash against
  the version, stored-PDF hash verification with tamper refusal, write-once
  backfill, storage privacy, no path leaks, and append-only DB triggers).
- Stage 9 additions: email verification (no auto-verify, single-use/expiring
  hashed tokens, resend cooldown, invitation gating), version-bound signatures
  (amendments need fresh signatures, notification fan-out), email OTP signing
  (hash storage, expiry, attempt lockout, cooldown, binding, honest assurance
  labels), three-way PDF/content/signature integrity (QR `pdfHash`, legacy
  `UNVERIFIED` instead of a false pass), the transactional email outbox and
  scheduler (idempotent dedupe keys, retries, preference suppression, manual
  reminder throttling) and platform-admin permissions (ordinary users refused,
  immutable published versions, append-only admin audit).
- Harness: `apps/api/test/helpers.ts`, truncates tables between tests, re-seeds
  templates, runs files sequentially (`fileParallelism: false`) against the test DB.
- `global-setup.ts` rebuilds the test schema from `db/migrations` + `db/seeds` once per run.

---

## Email, reminders and the scheduler

- Every outbound message is queued in `email_outbox` in the same transaction
  as the business change; a worker sends it after commit with exponential
  backoff (`EMAIL_RETRY_MAX`), `FOR UPDATE SKIP LOCKED` claiming and a
  dedupe key that prevents duplicate sends. Configure `EMAIL_TRANSPORT=console`
  for development, `smtp` for real delivery (plus `EMAIL_SMTP_*`), `memory`
  for tests, or `disabled`.
- Covered messages: invitation, email verification, password reset, signature
  request, agreement completion, expiry warning/expired, signature reminder
  and the six-digit signing OTP.
- The in-process scheduler (`SCHEDULER_INTERVAL_MS`, default 5 minutes) drives
  expiry transitions (`ACTIVE → EXPIRING → EXPIRED`), the expiry reminder
  ladder (`EXPIRY_WARN_DAYS`), signature reminders
  (`REMINDER_SIGNATURE_INTERVAL_DAYS` / `REMINDER_SIGNATURE_MAX`), outbox
  delivery and retention cleanup. Ticks are serialized with a PostgreSQL
  advisory lock and every reminder carries a dedupe key, so re-running a tick
  never duplicates a message. Set the interval to `0` to disable the timer.
- Owners can also send one manual signature reminder per signer per hour via
  `POST /agreements/:id/remind` (capped, throttled and audited).

## Platform administration

- `users.is_platform_admin` grants the platform console at `/admin`:
  user search/suspension (sessions revoked), template drafts → published
  versions (published rows are immutable; changes create new versions),
  category enable/disable, platform statistics and activity.
- Registering with an address in `PLATFORM_ADMIN_EMAILS` grants the flag
  automatically; in production prefer setting the column directly. Every
  admin action is written to the append-only `platform_audit_events` table.
- Organization owners are never platform administrators, and the last
  administrator cannot demote or suspend themselves.

---

## Configuration

See [`.env.example`](.env.example). Key variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | *(required)* | Dev database connection |
| `TEST_DATABASE_URL` | `…/agreementhub_test` | Test database (name must contain `test`) |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | HTTP bind |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Base for verification links |
| `WEB_ORIGIN` | `http://localhost:3001` | Browser origin allowed by CORS/CSRF checks |
| `CORS_ORIGINS` | *(empty)* | Extra comma-separated allowed browser origins |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` (only behind a reverse proxy) |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |
| `AGREEMENT_ID_PREFIX` | `AGR-GH` | Public ID prefix (`AGR-GH-2026-000001`) |
| `RATE_LIMIT_MAX` | `300` | Requests/window/IP (`0` disables rate limiting) |
| `AUTH_RATE_LIMIT_MAX` | `20` | Credential-endpoint requests/window/IP |
| `LOG_LEVEL` | `info` | Pino log level |
| `EMAIL_TRANSPORT` | `console` | `console` \| `smtp` \| `memory` \| `disabled` (queued via `email_outbox`) |
| `EMAIL_FROM` | `AgreementHub <no-reply@…>` | From header for outbound mail |
| `EMAIL_SMTP_HOST` / `PORT` / `USER` / `PASS` / `SECURE` | *(unset)* / `587` / *(unset)* | SMTP settings for `EMAIL_TRANSPORT=smtp` |
| `EMAIL_RETRY_MAX` | `5` | Delivery attempts before an outbox row is marked `FAILED` |
| `EMAIL_RETENTION_DAYS` | `30` | Delivered outbox rows retained before cleanup |
| `SCHEDULER_INTERVAL_MS` | `300000` | Background tick interval (`0` disables the timer) |
| `EXPIRY_WARN_DAYS` | `30,7,1` | Days-before-expiry reminder ladder |
| `REMINDER_SIGNATURE_INTERVAL_DAYS` | `3` | Days between signature reminders |
| `REMINDER_SIGNATURE_MAX` | `5` | Maximum automatic signature reminders |
| `PLATFORM_ADMIN_EMAILS` | *(empty)* | Comma-separated emails auto-granted admin at registration (prefer the DB flag in production) |
| `AI_PROVIDER` | `rules` | Assistant backend: `rules` (offline, no key) or `openai` |
| `OPENAI_API_KEY` | *(unset)* | Server-side key for `AI_PROVIDER=openai` (never sent to the browser) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `AI_MODEL` | `gpt-4o-mini` | Model name for the OpenAI-compatible provider |
| `STORAGE_DIR` | `./storage` | Server-side storage root (document PDFs in `documents/…`; never exposed via the API) |
| `PDF_GENERATION` | `on` | `on`/`off`, generate PDFs at finalization/on demand |
| `PDF_BROWSER_PATH` | *(auto)* | Chrome/Edge executable for the PDF renderer (auto-detected when unset) |

---

## Status / roadmap

- [x] Stage 1, full specification (`docs/SPEC.md`)
- [x] Stage 2, backend foundation: schema, security, services, version control,
      audit, REST API, automated tests
- [x] Stage 3, responsive Next.js frontend: auth (login/register/forgot/reset),
      onboarding, dashboard, agreement list with filters, agreement detail with
      working actions (sign/approve/transition/invite/finalize), draft editor,
      version history + diffs, audit trail + CSV export, document download,
      notifications, settings (profile/security/sessions), public verification page
- [x] Stage 4, agreement template engine: data-driven template definitions
      (fields, guidance, conditional sections/logic), dynamic form rendering in the
      draft editor, draft generation from fields (placeholders resolved,
      conditions applied), structured document preview, required-field validation
      gates on approvals/signing/finalization, five initial templates
- [x] Stage 5, AI Agreement Assistant: provider abstraction (deterministic
      offline `rules` default + OpenAI-compatible backend, keys server-side
      only), plain-language → field extraction with mandatory per-field
      confirmation (applied only via user PATCH with provenance
      `AI_SUGGESTED_CONFIRMED`), missing-information review, plain-language
      clause explanation, agreement summary, suggested questions, every
      response disclaimed, all `/ai/*` routes read-only, metadata-only logging
- [x] Stage 6, negotiation & version management: automatic versioning during
      negotiation (derived summaries, no version on no-op edits), version
      timeline + two-version comparison with word-level added/removed
      highlighting, section comments with `OPEN`/`RESOLVED` status (author or
      manager only), suggest → accept/reject workflow that **never** changes
      terms by itself, and finalization lock with an amendment flow whose final
      version stays sealed and publicly verifiable
- [x] Stage 7, signing & verification hardening: MVP signing methods
      (typed name / drawn signature / explicit acceptance) with the method
      bound into the payload hash and clearly labelled on every record,
      immutable signature records (DB trigger), QR codes for public
      verification (share dialog + verify page), audit event classification
      (user / agreement / system) with filter chips and a CSV `category`
      column, and the verification page checklist (agreement found · final
      version · integrity verified) with the agreement category
- [x] Stage 8, document generation & printing: professional HTML layout
      (branding, meta grid, numbered sections, key-terms/parties tables,
      Provider/Client signature blocks with Name · Signature · Date), draft
      vs. final labelling (`DRAFT: NOT FINAL` banner + watermark vs
      `FINAL AGREEMENT`), A4 print CSS with in-app preview modal (Print +
      Download PDF), immutable final PDF generated inside the finalization
      transaction (headless Chromium via `puppeteer-core`, network-isolated),
      SHA-256 recorded against the final version in the append-only
      `generated_documents` table, private write-once storage with
      hash-verified controlled downloads, backfill for pre-pipeline finals,
      `DOCUMENT_GENERATED` audit event
- [x] Stage 9, post-implementation security/quality audit:
      hashed single-use email verification with invitation gating; signatures
      bound to the exact version (amendments require fresh signatures and
      re-notify every signer); real EMAIL_OTP signing (crypto-random, hashed,
      expiring, attempt-limited, agreement/version/party bound) with honest
      identity-assurance labels; independent content/PDF/signature integrity
      checks (final PDF digest carried by the QR link); hardened security
      middleware (CORS allowlist, CSRF origin checks, headers, proxy trust);
      transactional email outbox + transport abstraction (invitations,
      verification, reset, signature requests, completion, expiry/reminders)
      with an idempotent scheduler; notification preferences; protected
      platform-admin console (users, templates/categories with immutable
      published versions, statistics, activity) with an append-only audit trail
- [ ] Attachments / file storage (document PDFs already use `STORAGE_DIR`;
      `MAX_UPLOAD_BYTES` reserved for uploads)
- [ ] Outbound email is implemented (queued, retried, transport-selectable);
      a production deployment still needs real SMTP credentials and DNS
      (SPF/DKIM), the default `console` transport only logs in development
