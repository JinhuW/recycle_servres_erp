# PayPal payments refused with "A transfer cannot be linked to an order"

**Symptom.** Linking a PayPal payment to its PO fails with *A transfer cannot be
linked to an order*, though the row sits in the unlinked queue and the page
suggests the right PO.

**Cause.** The row is a pair, and its Mercury leg has `category = 'transfer'`.
Two ways that happened:

1. **A taught counterparty took a card charge.** Mark as transfer on a row
   writes `bank_transfer_counterparties (source, counterparty)`, and every sync
   re-applies it. Mercury names the counterparty of a `PAYPAL *name` card charge
   "PayPal", the same as an ACH move to our own PayPal balance, so a rule taught
   on one of those caught every vendor payment made by card through PayPal. The
   rule skips pending rows, so a charge paired while pending and was turned into
   a transfer when it settled. Fixed in v1.482.1 (`counterpartyRuleTargetFrag`
   in `banktx/match.ts` skips paired legs and `PAYPAL *` charges; migration 0257
   repaired the rows).
2. **The payment was funded by an ACH pull.** `PAYPAL; PURCHASE …` and
   `PAYPAL; INST XFER …` are classified transfers by `mercuryTxnCategory`
   itself. `/link` now judges a pair by its PayPal leg.

**Diagnose.**

```sql
SELECT source, description, counterparty, category, category_manual, pair_id
FROM bank_transactions
WHERE id = '<id>' OR pair_id = (SELECT pair_id FROM bank_transactions WHERE id = '<id>');
SELECT * FROM bank_transfer_counterparties;
```

**Gotcha while querying from a Node script.** A regex such as `'^PAYPAL \*'`
inside a JS template literal loses its backslash (`\*` cooks to `*`), so it
silently becomes `^PAYPAL *` and matches the `PAYPAL;` ACH rows too. Use
`LIKE 'PAYPAL *%'` or `String.raw`.
