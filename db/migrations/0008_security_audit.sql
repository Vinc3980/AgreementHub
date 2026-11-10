-- 0008: Post-implementation audit fixes.
--
-- 1) Signature records gain a replayable payload snapshot + honest identity
--    assurance marker (EMAIL_OTP vs authenticated session only).
-- 2) Per-user notification preferences and a platform-administrator flag.
-- 3) Transactional email outbox (emails are enqueued with business state and
--    delivered by a worker, never sent from inside a database transaction).
-- 4) Append-only platform-admin audit trail.

-- ---------------------------------------------------------------------------
-- Signatures
-- ---------------------------------------------------------------------------

-- The exact canonical object that produced signature_payload_hash. Stored so
-- verification can recompute the digest rather than trusting the column alone.
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS payload_snapshot jsonb;

-- Only a completed email OTP may claim email ownership. Everything else was
-- signed from an authenticated session and must be described as such.
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS identity_assurance text
  NOT NULL DEFAULT 'AUTHENTICATED_SESSION'
  CHECK (identity_assurance IN ('AUTHENTICATED_SESSION', 'EMAIL_OTP_VERIFIED'));

-- Metadata is useful for the audit trail but was previously only in the app log.
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS request_id text;

-- ---------------------------------------------------------------------------
-- Users: notification preferences + platform administrator
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences jsonb
  NOT NULL DEFAULT '{}'::jsonb;

-- Platform administrators are a separate concept from organization OWNERs:
-- an org owner must never implicitly gain platform-wide privileges.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean
  NOT NULL DEFAULT false;

CREATE INDEX users_platform_admin_idx ON users (id) WHERE is_platform_admin;

-- ---------------------------------------------------------------------------
-- Transactional email outbox
-- ---------------------------------------------------------------------------

CREATE TABLE email_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email        text NOT NULL,
  template        text NOT NULL CHECK (template IN (
                    'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'INVITATION',
                    'SIGNATURE_REQUEST', 'SIGNATURE_OTP', 'AGREEMENT_FINALIZED',
                    'AGREEMENT_EXPIRED', 'EXPIRY_REMINDER', 'SIGNATURE_REMINDER', 'GENERIC'
                  )),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts        int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One email per idempotency key. NULLs are distinct, so unkeyed rows are fine.
CREATE UNIQUE INDEX email_outbox_dedupe_key_key ON email_outbox (dedupe_key);
CREATE INDEX email_outbox_pending_idx ON email_outbox (status, next_attempt_at);
CREATE INDEX email_outbox_created_idx ON email_outbox (created_at DESC);

-- ---------------------------------------------------------------------------
-- Platform administrator audit trail (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE platform_audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_label text NOT NULL DEFAULT '',
  action      text NOT NULL,
  target_type text,
  target_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_events_created_idx
  ON platform_audit_events (created_at DESC);

CREATE OR REPLACE FUNCTION block_platform_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform audit events are append-only (% denied)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_audit_events_append_only
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION block_platform_audit_mutation();

-- ---------------------------------------------------------------------------
-- Verification: keep the three integrity checks separate and auditable
-- (canonical content, finalized PDF bytes, signature records).
-- ---------------------------------------------------------------------------

ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS pdf_hash text;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS content_result text;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS pdf_result text;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS signature_result text;

