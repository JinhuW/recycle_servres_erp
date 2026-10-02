-- The currency a row's amount is in. Every PO is in USD, and every amount
-- comparison in reconciliation (pairing, the PO suggestions, auto-link, the
-- paid figure) assumed the bank rows were too. A PayPal row in another
-- currency would have matched a USD payment of the same number. Rows that are
-- not USD are now kept out of reconciliation and shown as such. Every prod row
-- was USD on 2026-10-02; the backfill reads PayPal's own field for any that
-- are not.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
UPDATE bank_transactions
   SET currency = upper(raw->'transaction_info'->'transaction_amount'->>'currency_code')
 WHERE source = 'paypal'
   AND raw->'transaction_info'->'transaction_amount'->>'currency_code' IS NOT NULL
   AND upper(raw->'transaction_info'->'transaction_amount'->>'currency_code') <> 'USD';
