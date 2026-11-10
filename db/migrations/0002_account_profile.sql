-- 0002: Account profile fields for onboarding + password reset tokens.
-- Deliberately minimal PII: phone / country / organization are optional,
-- user_type is a coarse enum. No documents, addresses, or payment data.

ALTER TABLE users
  ADD COLUMN phone text,
  ADD COLUMN country text,
  ADD COLUMN organization_name text,
  ADD COLUMN user_type text
    CHECK (user_type IS NULL OR user_type IN
           ('INDIVIDUAL', 'FREELANCER', 'SMALL_BUSINESS', 'PROFESSIONAL', 'ORGANIZATION')),
  ADD COLUMN onboarding_completed_at timestamptz;

-- Password reset: only the SHA-256 hash of the token is stored (same scheme
-- as sessions/invitations). Single-use, short-lived.
CREATE TABLE password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);
