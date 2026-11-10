/* 0012, Allow obligation reminder email templates in outbox (additive) */

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'email_outbox' AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%template%IN%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE email_outbox DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE email_outbox
  ADD CONSTRAINT email_outbox_template_check CHECK (template IN (
    'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'INVITATION',
    'SIGNATURE_REQUEST', 'SIGNATURE_OTP', 'AGREEMENT_FINALIZED',
    'AGREEMENT_EXPIRED', 'EXPIRY_REMINDER', 'SIGNATURE_REMINDER',
    'OBLIGATION_REMINDER', 'OBLIGATION_OVERDUE', 'GENERIC'
  ));
