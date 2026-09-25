-- One-off. Reconciliation started in earnest in August 2026; what was still
-- unlinked from before then will never be linked and only pads the queue.
-- Same predicate as openRowFrag (banktx/match.ts) plus the date.
UPDATE bank_transactions
SET ignored = TRUE
WHERE order_id IS NULL AND NOT ignored AND category = 'external'
  AND settle_status NOT IN ('failed', 'reversed')
  AND posted_at < '2026-08-01 00:00:00 America/Denver'::timestamptz;

-- A group is ignored whole: a Jul-31 PayPal charge whose Mercury settlement
-- posted on Aug 1 must not be left half-ignored across the boundary.
UPDATE bank_transactions bt
SET ignored = TRUE
FROM bank_transactions s
WHERE bt.pair_id = s.pair_id AND s.ignored
  AND NOT bt.ignored AND bt.order_id IS NULL;
