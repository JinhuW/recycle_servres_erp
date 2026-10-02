-- When a sell order became Done: the date a sale belongs to. The dashboard and
-- the contribution breakdowns dated sales by updated_at, which every later
-- edit moves (a note, an attachment, an archive), so a sale could drift into
-- whichever month someone last touched it. Done is terminal, so this is set
-- once and never cleared.
ALTER TABLE sell_orders ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

-- Backfill from the most reliable record there is: the status change to Done,
-- then the Done evidence row, then updated_at as a last resort. Prod's 35 Done
-- orders all had the first two on 2026-10-02.
UPDATE sell_orders so
   SET done_at = COALESCE(
         (SELECT MAX(e.created_at) FROM sell_order_events e
           WHERE e.sell_order_id = so.id AND e.kind = 'status_changed'
             AND e.detail->>'to' = 'Done'),
         (SELECT m.set_at FROM sell_order_status_meta m
           WHERE m.sell_order_id = so.id AND m.status = 'Done'),
         so.updated_at)
 WHERE so.status = 'Done' AND so.done_at IS NULL;

CREATE INDEX IF NOT EXISTS sell_orders_status_done_at_idx ON sell_orders (status, done_at);
