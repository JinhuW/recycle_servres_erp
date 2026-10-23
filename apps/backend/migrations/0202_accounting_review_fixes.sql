-- A question goes to the manager it was asked of. 0197 worked the addressee
-- out on every read (the author, else the entry's manager), so for an entry
-- nobody wrote, a payer that followed the PO handed an open question to
-- whoever paid now — someone who was never told, and could be the asker.
-- It is stored when the question is asked.
ALTER TABLE accounting_entries
  ADD COLUMN query_to UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE accounting_entries SET query_to = COALESCE(author_id, manager_id) WHERE query_at IS NOT NULL;

CREATE INDEX accounting_entries_query_to_idx ON accounting_entries (query_to);

-- Events in the order they were written. NOW() is the transaction's start, so
-- every event one transaction writes shared a timestamp and read back in id
-- order, which is random: a restore's catch-up edit could show before the
-- restore itself.
ALTER TABLE accounting_entry_events ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- Who the transaction acts for: the routes that can move a payer set
-- app.actor_id (db.ts actAsTx), and the sync reads it.
--
-- Three changes to 0200's function:
--
-- A payer that follows the PO is a new version, and its author is the manager
-- whose save moved it, as an edit of the entry makes its editor the author.
-- Keeping the old author let the manager who moved the payer sign the move
-- off and refused the one who had written the entry. A save nobody made (the
-- bank sync) or a purchaser made keeps the author: a purchaser doesn't review.
--
-- Only a restore of what this sync voided keeps it from voiding the entry
-- again. Any restore did, so an entry once voided and restored by hand stayed
-- on the book after its PO turned out to be paid from the Business Account.
--
-- The entries are locked before they are read, so a sign-off or a void that
-- commits meanwhile is what the move sees, not a snapshot from before it.
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
