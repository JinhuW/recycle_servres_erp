-- A line whose units never arrived is counted down to 0 instead of deleted:
-- deleting renumbers every line after it, because a line's # is its rank on
-- the PO. Only an existing line may sit at 0 — creating one still asks for at
-- least 1, which the app enforces (lib/orderInput.ts), not this CHECK.
ALTER TABLE order_lines
  DROP CONSTRAINT order_lines_qty_check,
  ADD CONSTRAINT order_lines_qty_check CHECK (qty >= 0);
