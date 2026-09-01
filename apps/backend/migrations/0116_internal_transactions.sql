-- Two pieces of state a bank transaction had nowhere to put: what an internal
-- movement was, and whose an unexplained payment is.
--
-- `pair_id` cannot serve the first — it is structurally two legs of one logical
-- payment (one Mercury, one PayPal, equal signed amounts) and collapses them
-- into a single feed row. A Mercury->PayPal transfer, a card-funding chain, a
-- top-up that arrived split in two: those are N legs with a story, and the
-- story has to be written down somewhere. `description` cannot hold it — the
-- provider owns that column and rewrites it on every sync.
CREATE TABLE internal_transactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT,
  note       TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX internal_transactions_created_by_idx ON internal_transactions (created_by);
-- Keyset feed for the record list (created_at DESC, id).
CREATE INDEX internal_transactions_feed_idx ON internal_transactions (created_at DESC, id);

ALTER TABLE bank_transactions
  ADD COLUMN internal_txn_id UUID REFERENCES internal_transactions(id) ON DELETE SET NULL,
  -- The owner of a payment nobody has explained yet. Unlike every other verdict
  -- on this table it does *not* take the row off the queue: the point of putting
  -- a payment on a person is that it still needs an answer.
  ADD COLUMN assignee_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN assigned_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN assigned_at     TIMESTAMPTZ,
  -- "assign a member when it is not linked to a PO" as an invariant rather than
  -- a convention: four code paths write a non-null order_id (link, auto-link,
  -- and both pair propagations), and each has to clear the owner or fail loudly
  -- rather than leave a payment owned by a person *and* settled by a PO.
  ADD CONSTRAINT bank_transactions_assignee_unlinked
    CHECK (assignee_id IS NULL OR order_id IS NULL),
  ADD CONSTRAINT bank_transactions_assigned_pair
    CHECK ((assignee_id IS NULL) = (assigned_at IS NULL));

CREATE INDEX bank_transactions_internal_txn_id_idx ON bank_transactions (internal_txn_id);
CREATE INDEX bank_transactions_assignee_id_idx     ON bank_transactions (assignee_id);
CREATE INDEX bank_transactions_assigned_by_idx     ON bank_transactions (assigned_by);
