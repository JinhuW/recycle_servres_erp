-- A Paid by that follows its PO is an edit the sign-off covers. Review mode
-- (0197) clears an entry's sign-off when a manager changes any field but the
-- note; 0199's sync moved an entry's Paid by with the sign-off left standing,
-- so a reviewed entry could read a payer its reviewer never saw. A move now
-- clears it the way the route's edit does: the entry reads Changed since
-- review, and the `edited` event names the sign-off it cleared, which the
-- review queue's diff and Activity read. The author stays: the trigger
-- doesn't know who saved the PO.
--
-- An entry that wasn't signed off keeps its state, an open question
-- included — a payer that followed the PO doesn't answer it.
--
-- Everything else is 0199's function as it stood.
CREATE OR REPLACE FUNCTION accounting_sync_payer(p_order_id TEXT, p_detail JSONB) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  WITH po AS (
    SELECT o.id, o.payment, o.paid_by, o.commission_paid_by,
           (o.commission_paid_by_company OR EXISTS (
              SELECT 1 FROM bank_transactions bt
              WHERE bt.order_id = o.id AND bt.link_kind = 'commission'
                AND bt.settle_status <> 'failed' AND bt.settle_status <> 'reversed'
           )) AS commission_business
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
       AND NOT EXISTS (SELECT 1 FROM accounting_entry_events r WHERE r.entry_id = e.id AND r.kind = 'restored')
    RETURNING e.id
  ), moved AS (
    UPDATE accounting_entries e
       SET manager_id = w.person, updated_at = NOW(),
           reviewed_by = NULL, reviewed_at = NULL,
           review_cleared_at = CASE WHEN w.reviewed_at IS NOT NULL THEN NOW() ELSE e.review_cleared_at END
      FROM want w
     WHERE w.id = e.id AND NOT w.business AND w.person IS NOT NULL AND w.person IS DISTINCT FROM w.prev
    RETURNING e.id, w.prev, w.person AS next, w.reviewed_by, w.reviewed_at
  )
  INSERT INTO accounting_entry_events (entry_id, kind, detail)
  SELECT id, 'voided', p_detail || jsonb_build_object('reason', 'Paid from the Business Account') FROM gone
  UNION ALL
  SELECT id, 'edited',
         p_detail || jsonb_build_object('changes', jsonb_build_object('managerId',
           jsonb_build_object('from', prev, 'to', next)))
         || CASE WHEN reviewed_at IS NULL THEN '{}'::jsonb
                 ELSE jsonb_build_object('clearedReview', jsonb_build_object('by', reviewed_by, 'at', reviewed_at)) END
  FROM moved;
END;
$$;
