-- The book (0191) started empty, but two fields already say a manager's money
-- moved: a PO's Paid by (0162), who paid the purchaser their commission, and a
-- Done sell order's payment receiver (0074), who took the buyer's money. Each
-- becomes the entry that manager would have recorded, against the purchaser
-- or the customer as the form fills it in.
--
-- The figure is the record's own: the PO's projected commission (the
-- Commission tab's, the bank picker's), the sell order's total in its own
-- currency. The receipts can't stand in: one is often uploaded on two orders,
-- a sale arrives in part-payments, a commission transfer can carry the cost
-- reimbursement too. Only their method is read, from the name the receipt
-- rename gives them (ai/receipt.ts), and only where an order's receipts agree.
--
-- A commission is dated by the first sign it was paid: its screenshot, or the
-- move to Done, which asks for one. Days are China's, where the managers keep
-- the RMB book, and a dollar figure is booked at the ledger's rate for its day.
--
-- A commission the company paid (on file, or a live bank row linked as the
-- commission) isn't a manager's money. A record the book already has an entry
-- for is left alone, which also makes a second run add nothing.
WITH receipts AS (
  SELECT a.order_id, NULL::text AS sell_order_id,
         substring(a.filename from '^\d{4}-\d{2}-\d{2}-(alipay|weixinpay|bank|zelle|paypal|venmo|cash|other)-\d') AS named
  FROM order_status_attachments a WHERE a.status = 'Commission'
  UNION ALL
  SELECT NULL, a.sell_order_id,
         substring(a.filename from '^\d{4}-\d{2}-\d{2}-(alipay|weixinpay|bank|zelle|paypal|venmo|cash|other)-\d')
  FROM sell_order_status_attachments a WHERE a.status IN ('Awaiting payment', 'Done')
), receipt_method AS (
  -- The book's methods; Zelle, PayPal and Venmo are Other there.
  SELECT order_id, sell_order_id,
         CASE WHEN COUNT(DISTINCT method) = 1 THEN MIN(method) ELSE 'other' END AS method
  FROM (
    SELECT order_id, sell_order_id,
           CASE named WHEN 'alipay' THEN 'alipay' WHEN 'weixinpay' THEN 'wechat'
                      WHEN 'bank' THEN 'bank' WHEN 'cash' THEN 'cash' ELSE 'other' END AS method
    FROM receipts WHERE named IS NOT NULL
  ) r
  GROUP BY order_id, sell_order_id
), commissions AS (
  SELECT 'out' AS direction, 'commission' AS kind, o.id AS order_id, NULL::text AS sell_order_id,
         o.commission_paid_by AS manager_id, left(pu.name, 200) AS counterparty,
         ROUND((GREATEST(rz.projected_profit, 0) * o.commission_rate)::numeric, 2) AS amount,
         'USD' AS currency,
         (COALESCE(
            LEAST(
              (SELECT MIN(a.uploaded_at) FROM order_status_attachments a
                WHERE a.order_id = o.id AND a.status = 'Commission'),
              (SELECT MIN(e.created_at) FROM order_events e
                WHERE e.order_id = o.id AND e.kind = 'advanced' AND e.detail->>'to' = 'done')),
            (SELECT MIN(e.created_at) FROM order_events e
              WHERE e.order_id = o.id AND e.kind = 'meta_changed'
                AND e.detail->'changes' @> '[{"field": "commission_paid_by"}]'))
          AT TIME ZONE 'Asia/Shanghai')::date AS occurred_on
  FROM orders o
  JOIN users pu ON pu.id = o.user_id
  -- The as-bought margin of lib/po-cost.ts (poFeeBasis, effUnitCost).
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(fl.qty_purchased, fl.qty) * fl.unit_cost), 0) AS goods,
           COALESCE(SUM(COALESCE(fl.qty_purchased, fl.qty)), 0) AS units
    FROM order_lines fl WHERE fl.order_id = o.id
  ) fee
  CROSS JOIN LATERAL (
    SELECT SUM((ol.sell_price - (ol.unit_cost + CASE
               WHEN fee.goods > 0 THEN o.other_fees * ol.unit_cost / fee.goods
               WHEN fee.units > 0 THEN o.other_fees / fee.units
               ELSE 0
             END)) * COALESCE(ol.qty_purchased, ol.qty)) AS projected_profit
    FROM order_lines ol WHERE ol.order_id = o.id
  ) rz
  WHERE o.commission_paid_by IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM bank_transactions bt
      WHERE bt.order_id = o.id AND bt.link_kind = 'commission'
        AND bt.settle_status <> 'failed' AND bt.settle_status <> 'reversed')
    AND NOT EXISTS (
      SELECT 1 FROM accounting_entries x WHERE x.order_id = o.id AND x.kind = 'commission')
), sales AS (
  SELECT 'in' AS direction, 'sale' AS kind, NULL::text AS order_id, so.id AS sell_order_id,
         so.payment_received_by AS manager_id, left(cu.name, 200) AS counterparty,
         t.total AS amount, so.currency_code::text AS currency,
         (so.done_at AT TIME ZONE 'Asia/Shanghai')::date AS occurred_on
  FROM sell_orders so
  JOIN customers cu ON cu.id = so.customer_id
  CROSS JOIN LATERAL (
    SELECT ROUND(COALESCE(SUM(sol.qty * COALESCE(sol.source_unit_price, sol.unit_price)), 0)::numeric, 2) AS total
    FROM sell_order_lines sol WHERE sol.sell_order_id = so.id
  ) t
  WHERE so.status = 'Done' AND so.payment_received_by IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM accounting_entries x WHERE x.sell_order_id = so.id AND x.kind = 'sale')
), entries AS (
  SELECT b.*, COALESCE(m.method, 'other') AS method,
         CASE WHEN b.currency = 'USD' THEN COALESCE(
           (SELECT r.rate FROM fx_rates r
             WHERE r.base_currency = 'USD' AND r.quote_currency = 'CNY' AND r.effective_date <= b.occurred_on
             ORDER BY r.effective_date DESC, r.fetched_at DESC LIMIT 1),
           (SELECT r.rate FROM fx_rates r
             WHERE r.base_currency = 'USD' AND r.quote_currency = 'CNY'
             ORDER BY r.effective_date, r.fetched_at LIMIT 1))
         END AS fx_rate
  FROM (SELECT * FROM commissions UNION ALL SELECT * FROM sales) b
  LEFT JOIN receipt_method m
    ON m.order_id IS NOT DISTINCT FROM b.order_id AND m.sell_order_id IS NOT DISTINCT FROM b.sell_order_id
  WHERE b.amount > 0 AND b.occurred_on IS NOT NULL
), numbered AS (
  -- Numbered in book order, so AC ids read the way the book does.
  SELECT e.*, row_number() OVER (ORDER BY e.occurred_on, e.order_id, e.sell_order_id) AS n
  FROM entries e
  WHERE e.currency = 'CNY' OR e.fx_rate IS NOT NULL
), counter AS (
  UPDATE id_counters SET value = value + (SELECT COUNT(*) FROM numbered)
   WHERE name = 'AC'
  RETURNING value - (SELECT COUNT(*) FROM numbered) AS base
), inserted AS (
  INSERT INTO accounting_entries
    (id, direction, kind, amount, currency, fx_rate, method, occurred_on, manager_id,
     order_id, sell_order_id, counterparty)
  SELECT 'AC-' || (c.base + n.n), n.direction, n.kind, n.amount, n.currency, n.fx_rate, n.method,
         n.occurred_on, n.manager_id, n.order_id, n.sell_order_id, n.counterparty
  FROM numbered n CROSS JOIN counter c
  RETURNING id, direction, kind, amount, currency, order_id, sell_order_id
)
-- No actor: nobody recorded these. `backfilled` names the field they came from.
INSERT INTO accounting_entry_events (entry_id, kind, detail, actor_id)
SELECT i.id, 'created',
       jsonb_build_object(
         'backfilled', CASE WHEN i.order_id IS NOT NULL THEN 'commission_paid_by' ELSE 'payment_received_by' END,
         'direction', i.direction, 'kind', i.kind, 'amount', i.amount, 'currency', i.currency,
         'targetId', COALESCE(i.order_id, i.sell_order_id)),
       NULL
FROM inserted i;
