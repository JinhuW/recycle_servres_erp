-- A sell order's product # is the number the packer labels its items with and
-- the receiver checks the box by. Until now it was derived on every read from
-- the packing-list sort (routes/sellOrders.ts), so a Draft add, a removed lot,
-- a transfer, a spec edit or a warehouse change renumbered the products after
-- it — labels already on items included.
--
-- It is stored from now on: given once, when the product is put on the order
-- (in packing-list order for the order's first products, then the next # for
-- each one added later), and never recomputed. Lots of one product share their
-- #, so it is not unique per order. The counter only goes up: a removed
-- product's # is never handed to another.
--
-- No backfill here: the old derivation is TypeScript (it folds by part number
-- and live lot labels), so the backend freezes the numbers every order shows
-- on boot, before taking requests (services/sellOrderNumbers.ts). Until then
-- the column is NULL, and a line an older instance writes mid-deploy stays
-- NULL until the next boot or save numbers it — so the column stays nullable.
ALTER TABLE sell_orders ADD COLUMN next_product_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sell_order_lines ADD COLUMN product_no INTEGER CHECK (product_no > 0);
CREATE INDEX sell_order_lines_order_product_no_idx ON sell_order_lines (sell_order_id, product_no);
