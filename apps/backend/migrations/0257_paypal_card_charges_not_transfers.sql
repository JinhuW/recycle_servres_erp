-- A rule taught on Mercury counterparty "PayPal" turned every "PAYPAL *name"
-- card charge into a transfer, because Mercury gives those the same
-- counterparty. They paid vendors. A charge caught before pairing never
-- paired, and one caught after could no longer be linked to its PO. The rule
-- now skips them (counterpartyRuleTargetFrag); this returns the rows it took.
-- A human verdict (category_manual) and a row filed under an internal
-- transaction stay as they are.
UPDATE bank_transactions
SET category = 'external'
WHERE source = 'mercury' AND category = 'transfer'
  AND NOT category_manual AND internal_txn_id IS NULL
  AND description LIKE 'PAYPAL *%';
