-- AgreementHub, initial schema
-- Conventions:
--   * UUID primary keys (uuid v4 via gen_random_uuid(); public Agreement IDs are separate)
--   * timestamptz everywhere, server-side defaults
--   * status constrained with CHECK (mirrors packages/domain enums)
--   * append-only tables protected by triggers (audit, versions, verification)
--   * soft deletion via deleted_at where noted

/* =================================================================== */
/* Identity                                                            */
/* =================================================================== */

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  password_hash    text NOT NULL,                     -- never exposed by any API
  display_name     text NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  email_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users (id),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);

CREATE TABLE organization_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL
             CHECK (role IN ('OWNER', 'ADMIN', 'CREATOR', 'REVIEWER', 'MEMBER')),
  status     text NOT NULL DEFAULT 'ACTIVE'
             CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  invited_by uuid REFERENCES users (id),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX organization_members_user_idx ON organization_members (user_id);

-- Server-side sessions. Only the SHA-256 hash of the session token is stored,
-- so a database leak does not yield usable credentials.
CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX auth_sessions_token_hash_key ON auth_sessions (token_hash);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at) WHERE revoked_at IS NULL;

/* =================================================================== */
/* Templates                                                           */
/* =================================================================== */

CREATE TABLE template_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  label      text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX template_categories_code_key ON template_categories (code);

CREATE TABLE agreement_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id       uuid NOT NULL REFERENCES template_categories (id),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  template_version  int NOT NULL DEFAULT 1 CHECK (template_version >= 1),
  -- Sections and field definitions live with the template (documented shape).
  content_schema    jsonb NOT NULL,
  signing_policy    text NOT NULL DEFAULT 'PARALLEL'
                    CHECK (signing_policy IN ('PARALLEL', 'SEQUENTIAL')),
  required_approvals int NOT NULL DEFAULT 1 CHECK (required_approvals >= 0),
  status            text NOT NULL DEFAULT 'PUBLISHED'
                    CHECK (status IN ('PUBLISHED', 'DRAFT', 'RETIRED')),
  created_by        uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, name, template_version)
);

CREATE INDEX agreement_templates_category_idx ON agreement_templates (category_id, status);

/* =================================================================== */
/* Agreements                                                          */
/* =================================================================== */

-- Per-year public ID allocation (AGR-GH-2026-000001). Row lock during
-- allocation guarantees uniqueness without relying on sequential PKs.
CREATE TABLE id_counters (
  key         text PRIMARY KEY,
  next_value  bigint NOT NULL CHECK (next_value > 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agreements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id          text NOT NULL,
  org_id             uuid NOT NULL REFERENCES organizations (id),
  title              text NOT NULL,
  category_id        uuid NOT NULL REFERENCES template_categories (id),
  template_id        uuid NOT NULL REFERENCES agreement_templates (id),
  template_version   int NOT NULL,
  status             text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN (
                       'DRAFT', 'REVIEW', 'NEGOTIATION', 'AWAITING_SIGNATURES',
                       'ACTIVE', 'EXPIRING', 'EXPIRED',
                       'CANCELLED', 'TERMINATED', 'REJECTED'
                     )),
  -- Plain-language intention captured at creation (AI inputs only come from here).
  brief              text,
  current_version_id uuid,   -- FK added after agreement_versions exists
  final_version_id   uuid,   -- FK added after agreement_versions exists
  created_by         uuid NOT NULL REFERENCES users (id),
  expires_at         timestamptz,
  finalized_at       timestamptz,
  closed_reason      text,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CHECK (final_version_id IS NULL OR finalized_at IS NOT NULL)
);

CREATE UNIQUE INDEX agreements_public_id_key ON agreements (public_id);
CREATE INDEX agreements_org_status_idx ON agreements (org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX agreements_created_by_idx ON agreements (created_by);
CREATE INDEX agreements_expires_idx ON agreements (expires_at)
  WHERE status IN ('ACTIVE', 'EXPIRING') AND deleted_at IS NULL;

CREATE TABLE agreement_parties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users (id),   -- linked on invitation acceptance
  email         text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'SIGNER'
                CHECK (role IN ('OWNER', 'CONTRIBUTOR', 'REVIEWER', 'SIGNER', 'OBSERVER')),
  signing_order int NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'INVITED'
                CHECK (status IN ('INVITED', 'VIEWED', 'APPROVED', 'SIGNED', 'DECLINED')),
  added_by      uuid REFERENCES users (id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  signed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agreement_parties_agreement_email_key
  ON agreement_parties (agreement_id, lower(email));
CREATE INDEX agreement_parties_user_idx ON agreement_parties (user_id);
CREATE INDEX agreement_parties_agreement_idx ON agreement_parties (agreement_id);

-- Mutable working copy of the document. Version snapshots are taken from here.
CREATE TABLE agreement_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  code         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  order_index  int NOT NULL DEFAULT 0,
  included     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agreement_sections_agreement_code_key
  ON agreement_sections (agreement_id, code);

CREATE TABLE agreement_fields (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  code         text NOT NULL,
  value        jsonb,
  provenance   text NOT NULL DEFAULT 'USER_PROVIDED'
               CHECK (provenance IN ('USER_PROVIDED', 'AI_SUGGESTED_CONFIRMED', 'COMPUTED')),
  updated_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agreement_fields_agreement_code_key
  ON agreement_fields (agreement_id, code);

CREATE TABLE agreement_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id        uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_number      int NOT NULL CHECK (version_number >= 1),
  content             jsonb NOT NULL,
  document_hash       text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  previous_version_id uuid REFERENCES agreement_versions (id),
  change_summary      text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'SUPERSEDED', 'PENDING_APPROVAL',
                                        'APPROVED', 'FINAL', 'REJECTED')),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  finalized_at        timestamptz,
  UNIQUE (agreement_id, version_number)
);

CREATE INDEX agreement_versions_agreement_idx ON agreement_versions (agreement_id, version_number);
CREATE INDEX agreement_versions_prev_idx ON agreement_versions (previous_version_id);

-- Circular FK: agreements ↔ agreement_versions
ALTER TABLE agreements
  ADD CONSTRAINT agreements_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES agreement_versions (id);
ALTER TABLE agreements
  ADD CONSTRAINT agreements_final_version_fk
  FOREIGN KEY (final_version_id) REFERENCES agreement_versions (id);

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id   uuid REFERENCES agreement_versions (id),
  section_code text,
  parent_id    uuid REFERENCES comments (id),
  author_type  text NOT NULL DEFAULT 'USER'
               CHECK (author_type IN ('USER', 'GUEST')),
  author_id    uuid REFERENCES users (id),
  author_label text NOT NULL DEFAULT '',
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX comments_agreement_idx ON comments (agreement_id, created_at);
CREATE INDEX comments_version_idx ON comments (version_id);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL DEFAULT 'SIGNER'
               CHECK (role IN ('OWNER', 'CONTRIBUTOR', 'REVIEWER', 'SIGNER', 'OBSERVER')),
  token_hash   text NOT NULL,          -- SHA-256 of the raw token; raw token never stored
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
CREATE INDEX invitations_agreement_email_idx ON invitations (agreement_id, lower(email));

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  uploaded_by   uuid NOT NULL REFERENCES users (id),
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key   text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_status   text NOT NULL DEFAULT 'PENDING'
                CHECK (scan_status IN ('PENDING', 'CLEAN', 'REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX attachments_agreement_idx ON attachments (agreement_id) WHERE deleted_at IS NULL;

/* =================================================================== */
/* Approvals, signatures                                               */
/* =================================================================== */

CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id   uuid NOT NULL REFERENCES agreement_versions (id),
  party_id     uuid NOT NULL REFERENCES agreement_parties (id) ON DELETE CASCADE,
  decision     text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  comment      text,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  actor_ip     text,
  actor_ua     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, party_id)
);

CREATE INDEX approvals_agreement_idx ON approvals (agreement_id);

CREATE TABLE signatures (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id           uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id             uuid NOT NULL REFERENCES agreement_versions (id),
  party_id               uuid NOT NULL REFERENCES agreement_parties (id) ON DELETE CASCADE,
  signer_user_id         uuid REFERENCES users (id),
  signer_email           text NOT NULL,
  method                 text NOT NULL DEFAULT 'SESSION'
                         CHECK (method IN ('SESSION', 'EMAIL_OTP')),
  signed_at              timestamptz NOT NULL DEFAULT now(),
  document_hash_at_signing text NOT NULL
                         CHECK (document_hash_at_signing ~ '^[0-9a-f]{64}$'),
  signature_payload_hash text NOT NULL
                         CHECK (signature_payload_hash ~ '^[0-9a-f]{64}$'),
  signature_text         text,
  consent_text_version   text NOT NULL DEFAULT 'v1',
  actor_ip               text,
  actor_ua               text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, party_id)
);

CREATE INDEX signatures_agreement_idx ON signatures (agreement_id);

/* =================================================================== */
/* Audit, verification, notifications                                  */
/* =================================================================== */

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid REFERENCES agreements (id),
  org_id       uuid REFERENCES organizations (id),
  seq          bigint,                      -- per-agreement chain position
  event_type   text NOT NULL,
  actor_type   text NOT NULL DEFAULT 'USER'
               CHECK (actor_type IN ('USER', 'GUEST', 'SYSTEM', 'AI')),
  actor_id     uuid,
  actor_label  text NOT NULL DEFAULT '',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id   text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,
  event_hash   text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  CHECK (agreement_id IS NOT NULL OR org_id IS NOT NULL)
);

-- Event types are validated by the application against the domain registry;
-- the hash chain makes later tampering detectable.
CREATE UNIQUE INDEX audit_events_agreement_seq_key ON audit_events (agreement_id, seq);
CREATE INDEX audit_events_agreement_idx ON audit_events (agreement_id, occurred_at);
CREATE INDEX audit_events_org_idx ON audit_events (org_id, occurred_at);
CREATE INDEX audit_events_type_idx ON audit_events (event_type);

CREATE TABLE verification_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for NOT_FOUND checks (attempt referenced an unknown Agreement ID)
  agreement_id   uuid REFERENCES agreements (id),
  version_id     uuid REFERENCES agreement_versions (id),
  result         text NOT NULL CHECK (result IN ('VERIFIED', 'MISMATCH', 'NOT_FOUND')),
  source         text NOT NULL DEFAULT 'URL'
                 CHECK (source IN ('QR', 'URL', 'API', 'MANUAL', 'SYSTEM')),
  requester_hash text,               -- hashed IP; raw IPs are not retained here
  recomputed_hash text CHECK (recomputed_hash IS NULL OR recomputed_hash ~ '^[0-9a-f]{64}$'),
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verification_records_agreement_idx ON verification_records (agreement_id, checked_at);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id       uuid REFERENCES organizations (id),
  agreement_id uuid REFERENCES agreements (id) ON DELETE CASCADE,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Plain UNIQUE index (NULLs are distinct), so ON CONFLICT (dedupe_key)
-- resolves without a predicate.
CREATE UNIQUE INDEX notifications_dedupe_key_key ON notifications (dedupe_key);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

/* =================================================================== */
/* updated_at maintenance                                               */
/* =================================================================== */

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organization_members_updated_at BEFORE UPDATE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER template_categories_updated_at BEFORE UPDATE ON template_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agreement_templates_updated_at BEFORE UPDATE ON agreement_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agreements_updated_at BEFORE UPDATE ON agreements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agreement_parties_updated_at BEFORE UPDATE ON agreement_parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agreement_sections_updated_at BEFORE UPDATE ON agreement_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agreement_fields_updated_at BEFORE UPDATE ON agreement_fields
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER comments_updated_at BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* =================================================================== */
/* Immutability guarantees (defense in depth, on top of application      */
/* rules, SPEC §8, §11, §12)                                           */
/* =================================================================== */

-- Agreement versions: content is editable only while status = 'DRAFT'
-- (working draft); once committed (PENDING_APPROVAL/APPROVED/SUPERSEDED/
-- REJECTED) the snapshot is frozen; FINAL rows are fully immutable and
-- rows can never be deleted (SPEC §8, §11).
CREATE OR REPLACE FUNCTION enforce_version_immutability() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agreement_versions rows cannot be deleted (append-only)';
  END IF;
  IF OLD.status = 'FINAL' THEN
    RAISE EXCEPTION 'finalized version % is immutable', OLD.id;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.document_hash IS DISTINCT FROM OLD.document_hash THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'committed version snapshot is immutable (status %); create a new version instead', OLD.status;
    END IF;
    -- DRAFT rows: version_number, provenance and lineage still never change
  END IF;
  IF NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id THEN
    RAISE EXCEPTION 'agreement version metadata is immutable; create a new version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreement_versions_immutable
  BEFORE UPDATE OR DELETE ON agreement_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_version_immutability();

-- Audit events: append-only for everyone, including application roles.
CREATE OR REPLACE FUNCTION block_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only (% denied)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- Verification records: append-only history of integrity checks.
CREATE OR REPLACE FUNCTION block_verification_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'verification_records are append-only (% denied)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER verification_records_append_only
  BEFORE UPDATE OR DELETE ON verification_records
  FOR EACH ROW EXECUTE FUNCTION block_verification_mutation();
