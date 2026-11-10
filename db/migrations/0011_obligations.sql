/* 0011, Post-signature obligations & reminders (Ghana-first evolution; additive) */

CREATE TABLE agreement_obligations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id        uuid NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
  version_id          uuid REFERENCES agreement_versions (id) ON DELETE SET NULL,
  responsible_party_id uuid REFERENCES agreement_parties (id) ON DELETE SET NULL,
  responsible_label   text,
  title               text NOT NULL,
  description         text,
  due_at              timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'UPCOMING'
                      CHECK (status IN ('UPCOMING', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'CANCELLED')),
  notes               text,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_obligations_completion_check
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT agreement_obligations_cancel_check
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX agreement_obligations_agreement_idx ON agreement_obligations (agreement_id, due_at);
CREATE INDEX agreement_obligations_due_idx ON agreement_obligations (due_at) WHERE status IN ('UPCOMING', 'DUE_SOON', 'OVERDUE');
CREATE INDEX agreement_obligations_party_idx ON agreement_obligations (responsible_party_id);

COMMENT ON TABLE agreement_obligations IS 'Post-signature obligation tracking. Time-based statuses may advance via scheduler; COMPLETED/CANCELLED are explicit user actions and never inferred from due date.';
