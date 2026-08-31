-- Money paid on a PO on top of the goods: a PayPal processing fee, freight,
-- customs. Until now the only place to put it was the total_cost override,
-- which hid it inside one opaque number and made a fee indistinguishable from
-- a negotiated discount.
--
-- Header columns rather than a child table: the rule is one amount per PO, and
-- a child table would buy an itemised breakdown nobody asked for at the cost of
-- a join in every profit/commission query in the app.
--
-- The fee ADDS to cost, so it reduces profit and therefore commission. Every
-- such query is line-level, so the fee is pushed down to the line pro-rata by
-- line cost — src/lib/po-cost.ts is the single definition of that rule.
-- It divides by the raw line subtotal SUM(qty*unit_cost), never by the
-- total_cost override: the override is a negotiated lot price that line-level
-- math already ignores everywhere, and using it as the denominator would
-- allocate other_fees * goods/override, i.e. lose part of the fee.
--
-- NOT NULL DEFAULT 0 so every arithmetic site can use the column bare. No
-- index: the columns are never filtered, joined, or ordered on.

ALTER TABLE orders
  ADD COLUMN other_fees      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other_fees >= 0),
  ADD COLUMN other_fees_note TEXT;
