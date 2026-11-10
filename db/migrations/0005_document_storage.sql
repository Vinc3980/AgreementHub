-- 0005: generated document storage (the document-generation pipeline:
-- HTML → PDF → hash → storage → verification).
--
-- One row per finalized version's immutable PDF. The storage_key is a
-- server-relative path under STORAGE_DIR and is never exposed through the
-- API, downloads go through the authenticated document routes only.

CREATE TABLE generated_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id   uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id     uuid NOT NULL UNIQUE REFERENCES agreement_versions (id) ON DELETE CASCADE,
  format         text NOT NULL DEFAULT 'PDF' CHECK (format IN ('PDF')),
  storage_key    text NOT NULL,
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size      bigint NOT NULL CHECK (byte_size > 0),
  engine         text NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_key)
);

CREATE INDEX generated_documents_agreement_idx ON generated_documents (agreement_id);

-- A generated document record is append-only: like signatures and audit
-- events, it can be added but never altered or removed, by users,
-- administrators, or the application itself. This is what makes the
-- finalized PDF immutable: the record and its hash are frozen, and the
-- stored bytes are verified against the hash on every download.
CREATE OR REPLACE FUNCTION block_generated_document_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'generated documents are immutable once recorded (% denied)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generated_documents_immutable
  BEFORE UPDATE OR DELETE ON generated_documents
  FOR EACH ROW EXECUTE FUNCTION block_generated_document_mutation();
