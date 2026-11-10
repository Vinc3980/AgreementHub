-- 0007: Signing OTP tokens (email-based OTP for signature verification).
-- Short-lived, hashed, single-use, bound to agreement+version+signer.

CREATE TABLE signature_otps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id    uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id      uuid NOT NULL REFERENCES agreement_versions (id) ON DELETE CASCADE,
  party_id        uuid NOT NULL REFERENCES agreement_parties (id) ON DELETE CASCADE,
  signer_email    text NOT NULL,
  otp_hash        text NOT NULL CHECK (otp_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  attempt_count   int NOT NULL DEFAULT 0,
  requested_ip    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Only one active OTP per party per version
CREATE UNIQUE INDEX signature_otps_active_party_version_key
  ON signature_otps (version_id, party_id)
  WHERE used_at IS NULL;

CREATE INDEX signature_otps_agreement_idx ON signature_otps (agreement_id);
CREATE INDEX signature_otps_party_idx     ON signature_otps (party_id);
