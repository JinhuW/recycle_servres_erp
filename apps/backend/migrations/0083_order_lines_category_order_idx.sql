-- A purchase order may now hold lines of several categories, so the order list's
-- `?category=` filter can no longer match on the orders row. It became a
-- semi-join over the lines:
--
--   EXISTS (SELECT 1 FROM order_lines ol
--            WHERE ol.order_id = o.id AND ol.category = $1)
--
-- Header-matching would hide every mixed PO from every category chip, which is
-- the failure this feature exists to prevent.
--
-- Leading with `category` (not `order_id`) is deliberate: the predicate is an
-- equality on category and a correlated equality on order_id, so this shape
-- makes it an index-only lookup. The existing order_lines indexes all lead with
-- order_id and can't serve it.

CREATE INDEX IF NOT EXISTS order_lines_category_order_idx
  ON order_lines (category, order_id);
