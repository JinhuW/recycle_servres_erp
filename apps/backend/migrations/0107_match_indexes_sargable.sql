-- 0105 added (total_cost, created_at) for the Payments match, but the
-- predicate wrapped the column in ABS(), so the planner never reached it.
-- match.ts now compares bare ranges; these are the indexes the rewritten
-- shape needs.
--
-- total_cost is the goods total and other_fees is what the bank actually
-- also charged, so the candidate test is a range on either — the sum needs
-- its own expression index.
CREATE INDEX IF NOT EXISTS orders_charged_total_created_at_idx
  ON orders ((total_cost + other_fees), created_at) WHERE archived_at IS NULL;

-- The txn-id branch is now a separate EXISTS (an OR spanning both branches
-- could use neither index), and it compares UPPER() on both sides.
CREATE INDEX IF NOT EXISTS orders_paypal_txn_upper_idx
  ON orders (UPPER(paypal_txn_id)) WHERE paypal_txn_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS packages_paypal_txn_upper_idx
  ON packages (UPPER(paypal_txn_id)) WHERE paypal_txn_id IS NOT NULL;
