-- Bank transactions synced from Mercury / PayPal, reconciled by managers
-- against purchase orders. One row per provider transaction (a "leg"); the
-- PayPal charge and its Mercury settlement for the same payment share
-- pair_id. Link columns are written identically onto every leg of a pair so
-- reads never need the sibling to know the link state.
CREATE TABLE bank_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL CHECK (source IN ('mercury', 'paypal')),
  external_id    TEXT NOT NULL,
  name           TEXT,
  last_synced_at TIMESTAMPTZ,
  -- Watermark (ISO timestamp) of the last completed sync. The next sync
  -- re-fetches an overlap window before it, because settlements post days
  -- after the charge; the (source, external_id) upsert keeps that idempotent.
  sync_cursor    TEXT,
  UNIQUE (source, external_id)
);

CREATE TABLE bank_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL CHECK (source IN ('mercury', 'paypal')),
  external_id   TEXT NOT NULL,
  account_id    UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  posted_at     TIMESTAMPTZ NOT NULL,
  -- Signed: negative = money out (payment to a seller), positive = money in
  -- (a refund coming back). Direction is always derived from the sign.
  amount        NUMERIC(12,2) NOT NULL,
  counterparty  TEXT,
  description   TEXT,
  -- PayPal legs: equals external_id. Mercury legs: parsed out of the bank
  -- description when it mentions PayPal. Drives auto-pair and the auto-link
  -- against orders.paypal_txn_id.
  paypal_txn_id TEXT,
  pair_id       UUID,
  -- Tombstones: a human Unpair/Unlink must survive every future re-sync, so
  -- the automatic matchers skip rows carrying them. Manual pair/link ignores
  -- them (they only gate "auto").
  no_auto_pair  BOOLEAN NOT NULL DEFAULT FALSE,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  link_kind     TEXT CHECK (link_kind IN ('payment', 'refund')),
  link_auto     BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL linked_by on a linked row = linked automatically.
  linked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at     TIMESTAMPTZ,
  no_auto_link  BOOLEAN NOT NULL DEFAULT FALSE,
  ignored       BOOLEAN NOT NULL DEFAULT FALSE,
  raw           JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, external_id),
  CHECK ((order_id IS NULL) = (linked_at IS NULL)),
  CHECK ((order_id IS NULL) = (link_kind IS NULL))
);

CREATE INDEX bank_transactions_account_id_idx ON bank_transactions (account_id);
CREATE INDEX bank_transactions_order_id_idx   ON bank_transactions (order_id);
CREATE INDEX bank_transactions_pair_id_idx    ON bank_transactions (pair_id);
CREATE INDEX bank_transactions_linked_by_idx  ON bank_transactions (linked_by);
-- Keyset feed for the Payments page (posted_at DESC, id).
CREATE INDEX bank_transactions_feed_idx       ON bank_transactions (posted_at DESC, id);
