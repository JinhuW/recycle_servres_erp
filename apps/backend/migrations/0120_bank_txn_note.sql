-- A payment can carry one human-written note. On the bank row rather than on
-- an internal-transaction record (0116): a record groups several movements
-- and asks for a story; this is "why does this $600 exist" on a single row,
-- linked or not. Written to every leg of a paired payment, like assignee_id —
-- the feed renders the PayPal leg alone, so a note on the Mercury leg only
-- would be invisible. Sync never touches it: the upsert names its columns.
ALTER TABLE bank_transactions
  ADD COLUMN note    TEXT,
  ADD COLUMN note_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN note_at TIMESTAMPTZ,
  ADD CONSTRAINT bank_transactions_note_pair CHECK ((note IS NULL) = (note_at IS NULL));

CREATE INDEX bank_transactions_note_by_idx ON bank_transactions (note_by);
