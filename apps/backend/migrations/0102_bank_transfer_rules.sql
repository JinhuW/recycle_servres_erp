-- Counterparty-taught transfers. A wire from a sibling company (e.g. an owner
-- entity funding Mercury) is indistinguishable from seller money in bank
-- metadata, so the manager teaches it once: mark-transfer records the
-- counterparty here and every sync classifies matching rows from then on.
CREATE TABLE bank_transfer_counterparties (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL CHECK (source IN ('mercury', 'paypal')),
  counterparty TEXT NOT NULL,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, counterparty)
);

CREATE INDEX bank_transfer_counterparties_created_by_idx
  ON bank_transfer_counterparties (created_by);

-- Mercury's own kind field identifies moves between the company's Mercury
-- accounts (and treasury sweeps) — internal by definition. Backfill from the
-- stored wire rows; the provider classifies new rows at fetch time.
UPDATE bank_transactions
SET category = 'transfer'
WHERE source = 'mercury'
  AND raw->>'kind' IN ('internalTransfer', 'treasuryTransfer')
  AND NOT category_manual;
