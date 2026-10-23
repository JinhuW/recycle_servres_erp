-- The RMB Flow records what the managers paid and received outside the
-- company's own account; the Business Account's money is the USD bank's,
-- reconciled on Payments. So an entry's Paid by and its PO's payer are one
-- value: a PO's person payer flows to its live entries, and a PO the
-- Business Account paid — the commission flagged company-paid or a live
-- Mercury/PayPal row linked as it, the cost paid from the company's account
-- — has no RMB entry: its live ones are voided, with the reason, restorable.
--
-- The write-back runs here, as triggers, because the PO's payer is written
-- from many places — the PO page, the commission screenshot, bank link /
-- unlink / pair, the bank sync's settle-status flips, a PO delete — and one
-- rule in the database covers them all. The other direction, an entry's Paid
-- by moving the PO, is the route's (routes/accounting.ts), which also
-- refuses an entry on a PO the Business Account paid.

-- Whose account the PO says paid, applied to its live paid-out entries of
-- that kind. Commission: the company when the flag is set or a live bank row
-- is linked as the commission (the rule banktx/match.ts commissionLinkedFrag
-- reads), else the manager on file. Purchase: the company when the cost was
-- paid from its account, else the cost payer. Nobody on file leaves the
-- entry as recorded. A write that changes nothing writes nothing, so the
-- route's own write-back (entry → PO → this function → the same entry) is a
-- no-op there.
--
-- An entry a manager has restored is never voided here again: the triggers
-- run on every PO save and settlement flip, and the restore is the last word.
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
    SELECT e.id, e.manager_id AS prev,
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
       SET manager_id = w.person, updated_at = NOW()
      FROM want w
     WHERE w.id = e.id AND NOT w.business AND w.person IS NOT NULL AND w.person IS DISTINCT FROM w.prev
    RETURNING e.id, w.prev, w.person AS next
  )
  INSERT INTO accounting_entry_events (entry_id, kind, detail)
  SELECT id, 'voided', p_detail || jsonb_build_object('reason', 'Paid from the Business Account') FROM gone
  UNION ALL
  SELECT id, 'edited',
         p_detail || jsonb_build_object('changes', jsonb_build_object('managerId',
           jsonb_build_object('from', prev, 'to', next)))
  FROM moved;
END;
$$;

CREATE OR REPLACE FUNCTION orders_sync_accounting_payer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM accounting_sync_payer(NEW.id, '{"synced": "po"}'::jsonb);
  RETURN NULL;
END;
$$;

-- A row linked, unlinked, moved to another PO, or whose settlement flipped:
-- the PO it left and the PO it joined both re-read their payer.
CREATE OR REPLACE FUNCTION bank_transactions_sync_accounting_payer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev_order TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.order_id END;
  next_order TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.order_id END;
BEGIN
  IF prev_order IS NOT NULL THEN
    PERFORM accounting_sync_payer(prev_order, '{"synced": "po"}'::jsonb);
  END IF;
  IF next_order IS NOT NULL AND next_order IS DISTINCT FROM prev_order THEN
    PERFORM accounting_sync_payer(next_order, '{"synced": "po"}'::jsonb);
  END IF;
  RETURN NULL;
END;
$$;

-- PO PATCH and the hand-off SET payment and paid_by on every save; the WHEN
-- keeps a save that moved neither from running the sync.
DROP TRIGGER IF EXISTS orders_sync_accounting_payer ON orders;
CREATE TRIGGER orders_sync_accounting_payer
  AFTER UPDATE OF commission_paid_by, commission_paid_by_company, payment, paid_by ON orders
  FOR EACH ROW
  WHEN (OLD.commission_paid_by IS DISTINCT FROM NEW.commission_paid_by
        OR OLD.commission_paid_by_company IS DISTINCT FROM NEW.commission_paid_by_company
        OR OLD.payment IS DISTINCT FROM NEW.payment
        OR OLD.paid_by IS DISTINCT FROM NEW.paid_by)
  EXECUTE FUNCTION orders_sync_accounting_payer();

DROP TRIGGER IF EXISTS bank_transactions_sync_accounting_payer ON bank_transactions;
CREATE TRIGGER bank_transactions_sync_accounting_payer
  AFTER INSERT OR DELETE OR UPDATE OF order_id, link_kind, settle_status ON bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION bank_transactions_sync_accounting_payer();

-- Once: every live entry on a PO catches up with it. The event says so.
SELECT accounting_sync_payer(l.order_id, '{"backfilled": "payer"}'::jsonb)
FROM (SELECT DISTINCT order_id FROM accounting_entries WHERE order_id IS NOT NULL AND voided_at IS NULL) l;
