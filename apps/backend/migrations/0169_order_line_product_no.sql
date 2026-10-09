-- A PO product's # is its id on the PO: given once, when the product is put on
-- the order, and never recomputed. Until now it was a live rank by
-- (position, created_at, id), so removing a product renumbered every product
-- after it, and a partial transfer's clone shifted the tail for good — along
-- with every sell order's "From PO-x #n" that named one of them.
--
-- The counter only goes up, so a removed product leaves a gap and its # is
-- never handed to another product. A partial transfer's clone is the same
-- product in another warehouse and carries its source's # (routes/inventory.ts),
-- so (order_id, product_no) is not unique.
ALTER TABLE orders ADD COLUMN next_product_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE order_lines ADD COLUMN product_no INTEGER CHECK (product_no > 0);

-- Every product keeps the # it shows today: ROW_NUMBER over the rank's own key.
UPDATE order_lines l
   SET product_no = r.n
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY position, created_at, id)::int AS n
          FROM order_lines) r
 WHERE r.id = l.id;

UPDATE orders o
   SET next_product_no = m.top + 1
  FROM (SELECT order_id, MAX(product_no) AS top FROM order_lines GROUP BY order_id) m
 WHERE m.order_id = o.id;

-- Labels already written on boxes carry these numbers: refuse to apply rather
-- than move one.
DO $$
DECLARE moved INTEGER;
BEGIN
  SELECT COUNT(*) INTO moved
    FROM order_lines l
   WHERE l.product_no <> (SELECT COUNT(*)::int + 1 FROM order_lines sib
                           WHERE sib.order_id = l.order_id
                             AND (sib.position, sib.created_at, sib.id) < (l.position, l.created_at, l.id));
  IF moved > 0 THEN
    RAISE EXCEPTION '0169: % PO product numbers differ from the rank they replace', moved;
  END IF;
END $$;

ALTER TABLE order_lines ALTER COLUMN product_no SET NOT NULL;
CREATE INDEX order_lines_order_product_no_idx ON order_lines (order_id, product_no);

-- The one allocator: any insert that names no # takes the order's next one, in
-- the insert's row order. Every such insert already holds the orders row (PO
-- PATCH locks it first) or has just created it (create, web-submission
-- convert), so this adds no lock in a lines-first transaction; the transfer
-- clone names its source's # and never gets here.
--
-- Hand-written SQL: a restore that names its old # must keep it below
-- next_product_no, and a row moved to another order must be given a # from
-- that order's counter — never carry the one it had.
CREATE OR REPLACE FUNCTION order_lines_number_product() RETURNS trigger AS $$
BEGIN
  UPDATE orders SET next_product_no = next_product_no + 1
   WHERE id = NEW.order_id
  RETURNING next_product_no - 1 INTO NEW.product_no;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_lines_number_product ON order_lines;
CREATE TRIGGER order_lines_number_product BEFORE INSERT ON order_lines
  FOR EACH ROW WHEN (NEW.product_no IS NULL) EXECUTE FUNCTION order_lines_number_product();
