-- The append-only triggers introduced in 0012 (inventory_events) and 0037
-- (order_events) raise on every UPDATE/DELETE. That correctly blocks direct
-- tampering, but it also blocks the FK cascade fired when a parent row is
-- legitimately removed (e.g. PATCH /api/orders/:id removeLineIds wiping an
-- advanced line that already has status events). Loosen the rule: allow
-- DELETE only when fired transitively from another trigger (pg_trigger_depth
-- > 1), so cascades pass but direct DELETE FROM still raises. UPDATE remains
-- blocked unconditionally — audit rows are immutable.

CREATE OR REPLACE FUNCTION inventory_events_lock() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'inventory_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_events_lock() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'order_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;
