-- Internal Mercury<->PayPal movements (top-ups, withdrawals, the funding leg
-- of a bank-funded PayPal payment) can never link to a purchase order, so they
-- are noise in the reconciliation queue. PayPal's transaction_event_code
-- identifies them deterministically (T03xx = bank deposit into PayPal,
-- T04xx = withdrawal back to a bank); category_manual pins a human verdict so
-- re-syncs never overwrite it.
ALTER TABLE bank_transactions
  ADD COLUMN category TEXT NOT NULL DEFAULT 'external'
    CHECK (category IN ('external', 'transfer')),
  ADD COLUMN category_manual BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill from the stored wire rows — no re-fetch needed.
UPDATE bank_transactions
SET category = 'transfer'
WHERE source = 'paypal'
  AND raw->'transaction_info'->>'transaction_event_code' ~ '^T0[34]';
