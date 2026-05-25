-- Sell orders were historically allocated as `SL-####`, picked at a time
-- when purchase orders held the `SO-` prefix. Migration 0044 freed `SO-`
-- by renaming purchase orders to `PO-`; this migration takes `SO-` back
-- for sell orders so the two surfaces use the symmetric pair PO / SO.
--
-- Mirrors 0044's shape: drop child FKs, disable the append-only trigger
-- on sell_order_events (mig 0050), UPDATE the parent + all five children
-- in lockstep, re-enable the trigger, re-create the FKs with their
-- original ON DELETE rules, then move the id_counters row.
--
-- Children that reference sell_orders(id) — all carry the prefix in TEXT
-- columns:
--   sell_order_lines.sell_order_id              (CASCADE, mig 0002)
--   sell_order_status_meta.sell_order_id        (CASCADE, mig 0003)
--   sell_order_status_attachments.sell_order_id (CASCADE, mig 0003)
--   sell_order_events.sell_order_id             (CASCADE, mig 0050)
--   vendor_bid_lines.sell_order_id              (NO ACTION, mig 0033)
--
-- Idempotent: every UPDATE is qualified `LIKE 'SL-%'`, so re-running on
-- an already-migrated database is a no-op. The id_counters rename is
-- also guarded by name.

ALTER TABLE sell_order_lines               DROP CONSTRAINT IF EXISTS sell_order_lines_sell_order_id_fkey;
ALTER TABLE sell_order_status_meta         DROP CONSTRAINT IF EXISTS sell_order_status_meta_sell_order_id_fkey;
ALTER TABLE sell_order_status_attachments  DROP CONSTRAINT IF EXISTS sell_order_status_attachments_sell_order_id_fkey;
ALTER TABLE sell_order_events              DROP CONSTRAINT IF EXISTS sell_order_events_sell_order_id_fkey;
ALTER TABLE vendor_bid_lines               DROP CONSTRAINT IF EXISTS vendor_bid_lines_sell_order_id_fkey;

ALTER TABLE sell_order_events DISABLE TRIGGER USER;

UPDATE sell_orders                  SET id            = 'SO-' || SUBSTRING(id            FROM 4) WHERE id            LIKE 'SL-%';
UPDATE sell_order_lines             SET sell_order_id = 'SO-' || SUBSTRING(sell_order_id FROM 4) WHERE sell_order_id LIKE 'SL-%';
UPDATE sell_order_status_meta       SET sell_order_id = 'SO-' || SUBSTRING(sell_order_id FROM 4) WHERE sell_order_id LIKE 'SL-%';
UPDATE sell_order_status_attachments SET sell_order_id = 'SO-' || SUBSTRING(sell_order_id FROM 4) WHERE sell_order_id LIKE 'SL-%';
UPDATE sell_order_events            SET sell_order_id = 'SO-' || SUBSTRING(sell_order_id FROM 4) WHERE sell_order_id LIKE 'SL-%';
UPDATE vendor_bid_lines             SET sell_order_id = 'SO-' || SUBSTRING(sell_order_id FROM 4) WHERE sell_order_id LIKE 'SL-%';

ALTER TABLE sell_order_events ENABLE TRIGGER USER;

ALTER TABLE sell_order_lines               ADD CONSTRAINT sell_order_lines_sell_order_id_fkey
  FOREIGN KEY (sell_order_id) REFERENCES sell_orders(id) ON DELETE CASCADE;
ALTER TABLE sell_order_status_meta         ADD CONSTRAINT sell_order_status_meta_sell_order_id_fkey
  FOREIGN KEY (sell_order_id) REFERENCES sell_orders(id) ON DELETE CASCADE;
ALTER TABLE sell_order_status_attachments  ADD CONSTRAINT sell_order_status_attachments_sell_order_id_fkey
  FOREIGN KEY (sell_order_id) REFERENCES sell_orders(id) ON DELETE CASCADE;
ALTER TABLE sell_order_events              ADD CONSTRAINT sell_order_events_sell_order_id_fkey
  FOREIGN KEY (sell_order_id) REFERENCES sell_orders(id) ON DELETE CASCADE;
ALTER TABLE vendor_bid_lines               ADD CONSTRAINT vendor_bid_lines_sell_order_id_fkey
  FOREIGN KEY (sell_order_id) REFERENCES sell_orders(id);

-- Rename the counter row. By the time this runs, mig 0044 has already
-- renamed the original `SO` row (purchase orders) to `PO`, so the `SO`
-- slot is free. If both somehow coexisted the PK conflict would surface
-- here, which is the desired loud failure.
UPDATE id_counters SET name = 'SO' WHERE name = 'SL';
