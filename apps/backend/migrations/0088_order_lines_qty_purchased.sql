-- order_lines.qty is how many units are still on the shelf: a sale decrements
-- it. The PO's derived goods total needs the other number — how many were
-- bought — and reading it off qty made a purchase cost that shrank every time
-- something sold, so the same PO recorded a different cost depending on how its
-- inventory happened to be split across sell orders.
--
-- NULL means "no sale has parted the two", i.e. the same as qty. Only the sell
-- and transfer paths ever write a value, so every INSERT can keep ignoring it.

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS qty_purchased INTEGER
  CONSTRAINT order_lines_qty_purchased_positive CHECK (qty_purchased > 0);

-- Backfill the lines a sale already parted. The first 'sold' event on a line
-- names both halves of the quantity it found there (soldQty + remainingQty), so
-- their sum is what the line held before anything was sold. That holds for a
-- line emptied in one go too: remainingQty is 0 and soldQty is the whole of it.
WITH first_sale AS (
  SELECT DISTINCT ON (order_line_id)
         order_line_id,
         (detail->>'soldQty')::int + COALESCE((detail->>'remainingQty')::int, 0) AS purchased
    FROM inventory_events
   WHERE kind = 'sold'
     AND detail->>'soldQty' IS NOT NULL
   ORDER BY order_line_id, created_at, id
)
UPDATE order_lines ol
   SET qty_purchased = f.purchased
  FROM first_sale f
 WHERE f.order_line_id = ol.id
   -- Only where the two actually differ; equal means qty still speaks for both.
   AND f.purchased > ol.qty;
