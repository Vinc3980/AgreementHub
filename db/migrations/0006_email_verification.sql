-- 0006: Proper email verification tokens.
-- Registration no longer sets email_verified_at automatically.
-- A cryptographically secure token is issued, hashed, stored, and
-- consumed exactly once within a short TTL.

CREATE TABLE email_verification_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_user_idx
  ON email_verification_tokens (user_id)
  WHERE used_at IS NULL;

-- Rate-limit: at most one pending token per user (application enforces
-- via ON CONFLICT; DB index enforces uniqueness of active token per user).
CREATE UNIQUE INDEX email_verification_tokens_active_user_key
  ON email_verification_tokens (user_id)
  WHERE used_at IS NULL;

-- Remove auto-verified flag set at registration for any existing records
-- that were set server-side. Existing verified users are preserved.
-- New registrations will have email_verified_at = NULL until they verify.
-- Note: we do NOT backfill-nullify existing records as that would
-- lock out already-registered users. Only future registrations change.
