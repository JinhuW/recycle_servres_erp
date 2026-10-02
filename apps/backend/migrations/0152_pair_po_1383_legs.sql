-- PO-1383 was paid once, $2,800 through PayPal to its seller on 2026-08-17,
-- funded by a Mercury debit "PAYPAL *BPTBULLDOG8" posted 2026-08-23. Both legs
-- were linked to the PO by hand and never grouped (six days is outside the
-- auto-pair window), so the PO's paid figure counted the payment twice. This
-- groups them, as /pair would.
--
-- Guarded on both ids, the PO, the amount and neither leg being paired yet, so
-- it touches nothing anywhere else and does nothing once the legs have been
-- grouped or changed. A fresh database has neither row.
WITH legs AS (
  SELECT id FROM bank_transactions
   WHERE id IN ('851ce964-46da-48d0-9ccd-ada3e41f2ed0'::uuid, '9f565f0e-3330-495d-a44e-545890d3f51e'::uuid)
     AND order_id = 'PO-1383' AND amount = -2800 AND pair_id IS NULL
), pair AS (
  -- One id for both legs; a volatile CTE is evaluated once.
  SELECT gen_random_uuid() AS id WHERE (SELECT COUNT(*) FROM legs) = 2
)
UPDATE bank_transactions t
   SET pair_id = pair.id
  FROM pair
 WHERE t.id IN (SELECT id FROM legs);
