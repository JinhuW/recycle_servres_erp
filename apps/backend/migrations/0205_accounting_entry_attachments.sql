-- The payment screenshots an RMB Flow entry is proved by. Stored in R2 like a
-- PO's status evidence, under the name the receipt OCR gives them
-- (<date>-<method>-<amount>.<ext>), so a list of them reads without opening
-- each. Proof, not money: a screenshot added or removed leaves the entry's
-- version and sign-off alone, and shows in its history.
CREATE TABLE accounting_entry_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     TEXT NOT NULL REFERENCES accounting_entries(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  mime_type    TEXT NOT NULL,
  storage_key  TEXT NOT NULL,
  delivery_url TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX accounting_entry_attachments_entry_idx ON accounting_entry_attachments (entry_id, uploaded_at);
CREATE INDEX accounting_entry_attachments_uploaded_by_idx ON accounting_entry_attachments (uploaded_by);

ALTER TABLE accounting_entry_events DROP CONSTRAINT accounting_entry_events_kind_check;
ALTER TABLE accounting_entry_events ADD CONSTRAINT accounting_entry_events_kind_check CHECK (kind IN (
  'created', 'edited', 'voided', 'restored', 'unlinked',
  'reviewed', 'unreviewed', 'queried', 'answered', 'query_withdrawn',
  'attachment_added', 'attachment_removed'
));
