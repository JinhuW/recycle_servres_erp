-- One-off legacy inventory push: creates warehouse WH-HK2 (Chai Wan, HK),
-- allocates the next PO-#### via id_counters, and inserts an 18-line RAM PO
-- owned by chao@recycleservers.com. unit_cost = 0 because no historical
-- pricing was recorded for this batch.
--
-- Run:
--   psql "$DATABASE_URL" -f apps/backend/scripts/legacy-ram-po.sql
-- Wrapped in BEGIN/COMMIT so the whole thing applies atomically (or rolls
-- back on any error). To dry-run, load it interactively instead:
--   psql "$DATABASE_URL"
--   \i apps/backend/scripts/legacy-ram-po.sql   -- then ROLLBACK; at the prompt

BEGIN;

DO $$
DECLARE
  v_purchaser_email TEXT := 'chao@recycleservers.com';
  v_warehouse_id    TEXT := 'WH-HK2';
  v_lifecycle       TEXT := 'done';   -- draft | in_transit | reviewing | done
  v_line_status     TEXT;
  v_user_id         UUID;
  v_po_id           TEXT;
BEGIN
  -- Per-line status mirrors LINE_STATUS_FOR_LIFECYCLE in routes/orders.ts.
  v_line_status := CASE v_lifecycle
    WHEN 'draft'      THEN 'Draft'
    WHEN 'in_transit' THEN 'In Transit'
    WHEN 'reviewing'  THEN 'Reviewing'
    WHEN 'done'       THEN 'Done'
  END;
  IF v_line_status IS NULL THEN
    RAISE EXCEPTION 'invalid lifecycle: %', v_lifecycle;
  END IF;

  SELECT id INTO v_user_id FROM users WHERE email = v_purchaser_email;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'user not found: %', v_purchaser_email;
  END IF;

  INSERT INTO warehouses (id, name, short, region, address, timezone, active, manager_user_id)
  VALUES (
    v_warehouse_id,
    'Hong Kong · Chai Wan',
    'HK2',
    'APAC',
    'Flat B2, 17/F, Block B, Winner Centre, 333 Chai Wan Road, Chai Wan, Hong Kong',
    'Asia/Hong_Kong',
    TRUE,
    v_user_id
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE id_counters
     SET value = value + 1
   WHERE name = 'PO'
   RETURNING 'PO-' || value INTO v_po_id;
  IF v_po_id IS NULL THEN
    RAISE EXCEPTION 'id_counters row "PO" missing (migration 0044 not applied?)';
  END IF;

  INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
  VALUES (
    v_po_id, v_user_id, 'RAM', v_warehouse_id, 'company',
    'Legacy inventory import (no historical cost recorded)',
    0.00, v_lifecycle
  );

  INSERT INTO order_lines
    (order_id, category, brand, capacity, generation, type, rank, speed, part_number, condition, qty, unit_cost, status, position)
  VALUES
    (v_po_id, 'RAM', 'Micron',   '16GB', 'DDR3',  'Server',  '2Rx4', 'PC3-14900',  'MT33JSF2G72PZ-1G9E1HE',       'Pulled — Tested', 211, 0.00, v_line_status,  0),
    (v_po_id, 'RAM', 'SK Hynix', '64GB', 'DDR4',  'Server',  '4Rx4', 'PC4-2400',   'HMAA8GL7MMR4N',               'Pulled — Tested',  10, 0.00, v_line_status,  1),
    (v_po_id, 'RAM', 'SK Hynix', '8GB',  'DDR4',  'Desktop', '4Rx4', 'PC4-2400',   'HMAA8GL7MMRAN-UN TE AC 1630', 'Pulled — Tested',  10, 0.00, v_line_status,  2),
    (v_po_id, 'RAM', 'SK Hynix', '64GB', 'DDR4',  'Server',  '2Rx4', 'PC4-2933',   'HMAA8GR7AJR4N-WM T4 AD',      'Pulled — Tested',  12, 0.00, v_line_status,  3),
    (v_po_id, 'RAM', 'SK Hynix', '8GB',  'DDR4',  'Desktop', '1Rx8', 'PC4-2666',   'HMA81GU6JJR8N-VK',            'Pulled — Tested',   1, 0.00, v_line_status,  4),
    (v_po_id, 'RAM', 'SK Hynix', '64GB', 'DDR4',  'Server',  '4Rx4', 'PC4-2400',   'HMAA8GL7MMR4N-UH TE AA 1632', 'Pulled — Tested',  12, 0.00, v_line_status,  5),
    (v_po_id, 'RAM', 'SK Hynix', '32GB', 'DDR4',  'Server',  '2Rx4', 'PC4-3200',   'HMA84GR7DJR4N-XN',            'Pulled — Tested',  18, 0.00, v_line_status,  6),
    (v_po_id, 'RAM', 'SK Hynix', '8GB',  'DDR4',  'Desktop', '1Rx8', 'PC4-2666',   'HMA81GU6JJR8N-VK',            'Pulled — Tested',   5, 0.00, v_line_status,  7),
    (v_po_id, 'RAM', 'SK Hynix', '8GB',  'DDR4',  'Laptop',  '1Rx8', 'PC4-2666',   'HMA81GS6DJR8N-VK',            'Pulled — Tested',   3, 0.00, v_line_status,  8),
    (v_po_id, 'RAM', 'SK Hynix', '8GB',  'DDR4',  'Laptop',  '1Rx8', 'PC4-2666',   'HMA81GS6JJR8N-VK',            'Pulled — Tested',   1, 0.00, v_line_status,  9),
    (v_po_id, 'RAM', 'SK Hynix', '8GB',  'DDR4',  'Desktop', '1Rx8', 'PC4-2666',   'HMA81GS6JJR8N-VK NO AC',      'Pulled — Tested',   3, 0.00, v_line_status, 10),
    (v_po_id, 'RAM', 'Samsung',  '32GB', 'DDR4',  'Server',  '2Rx4', 'PC4-2400',   'M392A4K40BMO-CRCOY',          'Pulled — Tested',  11, 0.00, v_line_status, 11),
    (v_po_id, 'RAM', 'Samsung',  '16GB', 'DDR4',  'Server',  '2Rx4', 'PC4-2133',   'M392A2G40DM0-CPB',            'Pulled — Tested',   2, 0.00, v_line_status, 12),
    (v_po_id, 'RAM', 'Samsung',  '32GB', 'DDR4',  'Server',  '2Rx4', 'PC4-2133',   'M392A4K40BM0-CPBOQ',          'Pulled — Tested',   2, 0.00, v_line_status, 13),
    (v_po_id, 'RAM', 'Samsung',  '32GB', 'DDR4',  'Server',  '2Rx4', 'PC4-2400',   'M392A4K40BM0-CRC0Q',          'Pulled — Tested',  11, 0.00, v_line_status, 14),
    (v_po_id, 'RAM', 'SK Hynix', '16GB', 'DDR4',  'Desktop', '2Rx8', 'PC4-3200',   'HMA82GR7DJR8N-XN T4 AD',      'Pulled — Tested',  16, 0.00, v_line_status, 15),
    (v_po_id, 'RAM', 'SK Hynix', '16GB', 'DDR4',  'Desktop', '2Rx8', 'PC4-2666',   'HMA82GS6CJR8N-VK NO AD 1952', 'Pulled — Tested',   3, 0.00, v_line_status, 16),
    (v_po_id, 'RAM', 'Samsung',  '16GB', 'DDR3L', 'Server',  '2Rx4', 'PC3L-12800', 'M393B2G70BH0-YK0',            'Pulled — Tested',  10, 0.00, v_line_status, 17);

  RAISE NOTICE 'Created % (lifecycle=%, warehouse=%, lines=18, total qty=341)',
    v_po_id, v_lifecycle, v_warehouse_id;
END $$;

-- Sanity-check rows (printed in the same transaction, before COMMIT).
SELECT id, lifecycle, total_cost, warehouse_id, created_at
  FROM orders ORDER BY created_at DESC LIMIT 1;

SELECT COUNT(*) AS lines, SUM(qty) AS total_qty
  FROM order_lines
 WHERE order_id = (SELECT id FROM orders ORDER BY created_at DESC LIMIT 1);

COMMIT;
