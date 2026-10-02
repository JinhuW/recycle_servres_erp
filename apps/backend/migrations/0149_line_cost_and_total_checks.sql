-- A unit cost or a goods total below zero has no meaning, and the profit and
-- commission maths read either straight through. POST /api/orders checked no
-- number at all until v1.197.1, so the database is the backstop the API
-- validation (lib/orderInput.ts) sits in front of. Prod had no violating row
-- when this was written (2026-10-02).
ALTER TABLE order_lines
  ADD CONSTRAINT order_lines_unit_cost_nonneg_ck CHECK (unit_cost >= 0);
ALTER TABLE orders
  ADD CONSTRAINT orders_total_cost_nonneg_ck CHECK (total_cost IS NULL OR total_cost >= 0);
