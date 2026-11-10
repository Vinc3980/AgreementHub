-- 0004: MVP signing methods (typed name / drawn signature / explicit
-- electronic acceptance) + completed signature records become immutable.

-- Old: SESSION, EMAIL_OTP only. Keep those values (legacy rows + API
-- clients) and add the three MVP methods.
ALTER TABLE signatures DROP CONSTRAINT signatures_method_check;
ALTER TABLE signatures ADD CONSTRAINT signatures_method_check
  CHECK (method IN ('SESSION', 'EMAIL_OTP', 'TYPED', 'DRAWN', 'CONSENT'));

-- Method-specific payload: drawn signature image (data URL) and any
-- extra per-method metadata. Never contains document content.
ALTER TABLE signatures ADD COLUMN signature_data jsonb;

-- A completed signature record cannot be altered or removed, by users,
-- administrators, or the application itself (mirrors audit_events).
CREATE OR REPLACE FUNCTION block_signature_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'signatures are immutable once recorded (% denied)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signatures_immutable
  BEFORE UPDATE OR DELETE ON signatures
  FOR EACH ROW EXECUTE FUNCTION block_signature_mutation();
