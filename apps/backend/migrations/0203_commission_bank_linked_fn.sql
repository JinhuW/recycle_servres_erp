-- Whether the company's own money paid a PO's commission through the bank: a
-- live Mercury/PayPal row linked as it. Failed and reversed rows paid nothing.
-- The routes (banktx/match.ts commissionLinkedFrag) and the payer sync both
-- call this, so tightening the rule changes what the PO page, the RMB Flow's
-- refusals and the sync's voids read at once. A one-statement SQL function
-- is inlined into the query that calls it.
CREATE FUNCTION order_commission_bank_linked(p_order_id TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bank_transactions bt
    WHERE bt.order_id = p_order_id AND bt.link_kind = 'commission'
      AND bt.settle_status <> 'failed' AND bt.settle_status <> 'reversed')
$$;

-- 0202's function, reading the rule above instead of its own copy of it.
CREATE OR REPLACE FUNCTION accounting_sync_payer(p_order_id TEXT, p_detail JSONB) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  actor UUID := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  author UUID;
BEGIN
  SELECT id INTO author FROM users WHERE id = actor AND role = 'manager';
  PERFORM 1 FROM accounting_entries
   WHERE order_id = p_order_id AND voided_at IS NULL AND direction = 'out' AND kind IN ('commission', 'purchase')
   ORDER BY id FOR UPDATE;
  WITH po AS (
    SELECT o.id, o.payment, o.paid_by, o.commission_paid_by,
           (o.commission_paid_by_company OR order_commission_bank_linked(o.id)) AS commission_business
    FROM orders o WHERE o.id = p_order_id
  ), want AS (
    SELECT e.id, e.manager_id AS prev, e.reviewed_by, e.reviewed_at,
           CASE e.kind WHEN 'commission' THEN po.commission_business
                       WHEN 'purchase' THEN po.payment = 'company' END AS business,
           CASE e.kind WHEN 'commission' THEN po.commission_paid_by
                       WHEN 'purchase' THEN po.paid_by END AS person
    FROM accounting_entries e
    JOIN po ON po.id = e.order_id
    WHERE e.voided_at IS NULL AND e.direction = 'out' AND e.kind IN ('commission', 'purchase')
  ), gone AS (
    UPDATE accounting_entries e
       SET voided_at = NOW(), voided_by = NULL, void_reason = 'Paid from the Business Account',
           updated_at = NOW()
      FROM want w
     WHERE w.id = e.id AND w.business
       AND NOT EXISTS (
         SELECT 1 FROM accounting_entry_events r
         WHERE r.entry_id = e.id AND r.kind = 'restored' AND r.detail->>'reason' = 'Paid from the Business Account')
    RETURNING e.id
  ), moved AS (
    UPDATE accounting_entries e
       SET manager_id = w.person, updated_at = NOW(), author_id = COALESCE(author, e.author_id),
           reviewed_by = NULL, reviewed_at = NULL,
           review_cleared_at = CASE WHEN w.reviewed_at IS NOT NULL THEN NOW() ELSE e.review_cleared_at END
      FROM want w
     WHERE w.id = e.id AND NOT w.business AND w.person IS NOT NULL AND w.person IS DISTINCT FROM w.prev
    RETURNING e.id, w.prev, w.person AS next, w.reviewed_by, w.reviewed_at
  )
  INSERT INTO accounting_entry_events (entry_id, kind, detail, actor_id)
  SELECT id, 'voided', p_detail || jsonb_build_object('reason', 'Paid from the Business Account'), actor FROM gone
  UNION ALL
  SELECT id, 'edited',
         p_detail || jsonb_build_object('changes', jsonb_build_object('managerId',
           jsonb_build_object('from', prev, 'to', next)))
         || CASE WHEN reviewed_at IS NULL THEN '{}'::jsonb
                 ELSE jsonb_build_object('clearedReview', jsonb_build_object('by', reviewed_by, 'at', reviewed_at)) END,
         actor
  FROM moved;
END;
$$;

-- The rate on a day (lib/fx.ts cnyPerUsdOnFrag): Review mode reads one per
-- listed entry, and the fetch-time index can't find a day.
CREATE INDEX fx_rates_pair_effective
  ON fx_rates (base_currency, quote_currency, effective_date DESC, fetched_at DESC);
