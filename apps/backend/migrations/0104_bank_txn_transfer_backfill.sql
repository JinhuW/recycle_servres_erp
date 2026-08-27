-- Re-categorize internal Mercury<->PayPal moves that synced before the
-- classifier learned them: PayPal T07xx card deposits (our own Mercury debit
-- card funding the balance) and Mercury ACH legs carrying the
-- "PAYPAL; <type>; <holder>" descriptor. Sync only revisits a 5-day overlap
-- window, so older rows need this one-time pass. Human verdicts
-- (category_manual) and linked rows are left alone, mirroring the sync rule.

UPDATE bank_transactions
SET category = 'transfer'
WHERE source = 'paypal'
  AND raw->'transaction_info'->>'transaction_event_code' ~ '^T0[347]'
  AND category = 'external' AND NOT category_manual AND order_id IS NULL;

UPDATE bank_transactions
SET category = 'transfer'
WHERE source = 'mercury'
  AND description LIKE 'PAYPAL;%'
  AND category = 'external' AND NOT category_manual AND order_id IS NULL;
