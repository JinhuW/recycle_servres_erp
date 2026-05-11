-- Lock inventory_events so neither the app nor a curious psql session can
-- mutate the audit log. Inserts are allowed; updates and deletes raise.

CREATE OR REPLACE FUNCTION inventory_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_events is append-only — UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_events_no_update ON inventory_events;
DROP TRIGGER IF EXISTS inventory_events_no_delete ON inventory_events;
CREATE TRIGGER inventory_events_no_update BEFORE UPDATE ON inventory_events
  FOR EACH ROW EXECUTE FUNCTION inventory_events_lock();
CREATE TRIGGER inventory_events_no_delete BEFORE DELETE ON inventory_events
  FOR EACH ROW EXECUTE FUNCTION inventory_events_lock();
