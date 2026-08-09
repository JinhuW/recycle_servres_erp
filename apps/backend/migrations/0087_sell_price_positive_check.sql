-- Hold the line 0086 drew: an unpriced order line has sell_price NULL, never 0.
--
-- 0086 converted the existing zeros and left the rule to application code —
-- `normSellPrice` in packages/shared collapses 0 -> NULL on every write path we
-- have today. That is fine until the next writer: an import, a seed, a hand
-- patch, or a restore of a pre-0086 dump reintroduces zeros silently, and the
-- split 0086 describes re-opens. The SQL aggregates count such a line as priced
-- and bill it at a $0 sale; every UI predicate counts it as unpriced. Nothing
-- errors — the numbers just stop agreeing, which is the hardest kind to notice.
--
-- Negatives are excluded by the same constraint. There is no reading of a
-- negative sale price, and the projected-margin queries would treat one as
-- revenue.

-- Idempotent re-run of 0086's conversion, widened to every value the constraint
-- rejects. This migration executes at container boot, so it must not be able to
-- fail on data a stale writer left behind: with this, the constraint below is
-- always applied to rows that already satisfy it.
--
-- `<= 0`, not `= 0`. Both API write paths reject a negative, but the writers
-- this constraint exists to guard — an import, a seed, a hand patch, a restore
-- of a pre-0086 dump — are exactly the ones that never saw that check. Matching
-- 0086 literally would leave one negative row able to fail the ALTER below, and
-- a migration that throws at boot is a backend that does not start.
UPDATE order_lines SET sell_price = NULL WHERE sell_price <= 0;

ALTER TABLE order_lines
  DROP CONSTRAINT IF EXISTS order_lines_sell_price_positive;

ALTER TABLE order_lines
  ADD CONSTRAINT order_lines_sell_price_positive
  CHECK (sell_price IS NULL OR sell_price > 0);
