/* =================================================================== */
/* 0003, Negotiation: comment status + change proposals                */
/* =================================================================== */

/* Comment lifecycle status (author/timestamp/section/content/status are all
   recorded per the negotiation spec). resolved_at stays the authoritative
   "when" and is kept in sync by the application. */
ALTER TABLE comments
  ADD COLUMN status text NOT NULL DEFAULT 'OPEN';

ALTER TABLE comments
  ADD CONSTRAINT comments_status_check CHECK (status IN ('OPEN', 'RESOLVED'));

UPDATE comments SET status = 'RESOLVED' WHERE resolved_at IS NOT NULL;

/* A change proposal is a suggestion only, applying it requires an explicit
   accept from a user with edit rights, which runs through the normal draft
   update path (and therefore creates a version during negotiation). */
CREATE TABLE change_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id      uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id        uuid REFERENCES agreement_versions (id),
  kind              text NOT NULL CHECK (kind IN ('TITLE', 'SECTION', 'FIELD')),
  target_code       text NOT NULL,
  current_value     jsonb,
  proposed_value    jsonb NOT NULL,
  note              text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  proposed_by       uuid NOT NULL REFERENCES users (id),
  proposed_by_label text NOT NULL DEFAULT '',
  decided_by        uuid REFERENCES users (id),
  decided_at        timestamptz,
  decision_note     text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX change_proposals_agreement_idx
  ON change_proposals (agreement_id, status, created_at);

-- At most one open suggestion per target (backstop behind the app check).
CREATE UNIQUE INDEX change_proposals_pending_target_key
  ON change_proposals (agreement_id, kind, target_code)
  WHERE status = 'PENDING';

CREATE TRIGGER change_proposals_updated_at BEFORE UPDATE ON change_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
