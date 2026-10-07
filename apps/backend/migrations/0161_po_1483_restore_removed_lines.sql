-- PO-1483 lost lines #32 and #36 on 2026-10-07: none of their units were in
-- the box, and a line couldn't be counted to 0 then, so they were deleted —
-- which renumbered every line after them. They come back at qty 0 in their
-- old places: the original position and created_at put each at the same #.
-- The specs are the rows as the nightly prod copy held them before the delete.
-- #36's label scan went with the delete (its R2 object was swept), so it comes
-- back without one; #32 shares #31's scan, which survived.
--
-- qty 0 adds nothing to the goods total, so total_cost stays as it is.
--
-- Guarded on the PO (present, not archived, not sold), on each line's own
-- line_removed event, and on the id being free, so it touches only those two
-- rows as they were lost and does nothing anywhere else or a second time. A
-- fresh database has no such events.
WITH v (id, category, brand, capacity, generation, classification, rank, speed,
        part_number, unit_cost, scan_image_id, scan_confidence, position, created_at) AS (
  VALUES
    ('d2e7da42-898a-44aa-9203-ba11c881702b'::uuid, 'RAM', 'Samsung', '16GB', 'DDR4', 'RDIMM', '2Rx8', '3200',
     'M393A2K43EB3-CWEBY', 25.00::numeric, 'label-scans/019089cc-188d-4cf0-b3f3-6918d8d5010c-label.jpg', 0.8::real,
     32, '2026-10-04 18:46:34.297516+00'::timestamptz),
    ('20eb59db-1567-4aa8-bf48-9f84fc9c0698'::uuid, 'RAM', 'SK Hynix', '16GB', 'DDR4', 'RDIMM', '1Rx4', '2666',
     'HMA82GR7CJRAN-VK', 25.00::numeric, NULL, NULL,
     36, '2026-10-04 18:51:57.199776+00'::timestamptz)
), back AS (
  SELECT v.*, o.id AS order_id, o.lifecycle, rm.actor_id
  FROM v
  JOIN orders o ON o.id = 'PO-1483' AND o.archived_at IS NULL AND o.lifecycle <> 'sold'
  JOIN LATERAL (
    SELECT e.actor_id FROM order_events e
     WHERE e.order_id = o.id AND e.kind = 'line_removed' AND e.detail->>'lineId' = v.id::text
     ORDER BY e.created_at DESC
     LIMIT 1
  ) rm ON TRUE
  WHERE NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.id = v.id)
), ins AS (
  INSERT INTO order_lines (id, order_id, category, brand, capacity, generation, classification, rank, speed,
                           part_number, condition, qty, unit_cost, status, scan_image_id, scan_confidence,
                           position, created_at, type)
  SELECT id, order_id, category, brand, capacity, generation, classification, rank, speed,
         part_number, 'Pulled — Tested', 0, unit_cost,
         -- The line status for the PO's stage, as orderAdvance's
         -- LINE_STATUS_FOR_LIFECYCLE maps it.
         CASE lifecycle WHEN 'draft' THEN 'Draft' WHEN 'in_transit' THEN 'In Transit'
                        WHEN 'reviewing' THEN 'Reviewing' ELSE 'Done' END,
         scan_image_id, scan_confidence, position, created_at, 'Server'
  FROM back
  RETURNING id, order_id, category, part_number, qty, unit_cost
)
-- In the activity log as the person who removed them, marked as a restore.
INSERT INTO order_events (order_id, actor_id, kind, detail)
SELECT i.order_id, b.actor_id, 'line_added',
       jsonb_build_object('lineId', i.id, 'category', i.category, 'partNumber', i.part_number,
                          'qty', i.qty, 'unitCost', i.unit_cost::float, 'restored', true)
FROM ins i
JOIN back b ON b.id = i.id;
