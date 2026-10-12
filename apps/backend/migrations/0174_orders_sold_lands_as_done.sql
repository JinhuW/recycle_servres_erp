-- 0173 moved every 'sold' PO back to 'done', but it runs at the new
-- container's boot while the old instance is still serving, and that instance
-- still settles a sold-out Done PO to 'sold' (a sell order reaching Done, a PO
-- landing on Done, a lot hand-set to Sold). Nothing reads 'sold' any more: it
-- would be an unknown stage, open on the closed book and shown raw to the
-- purchaser. So a 'sold' written from here on lands as 'done' — what 0173
-- made of the ones before it — and the old instance's settle stays harmless
-- through the overlap and any rollback.
CREATE OR REPLACE FUNCTION orders_sold_lands_as_done() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.lifecycle := 'done';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_sold_lands_as_done ON orders;
CREATE TRIGGER orders_sold_lands_as_done
  BEFORE INSERT OR UPDATE OF lifecycle ON orders
  FOR EACH ROW WHEN (NEW.lifecycle = 'sold')
  EXECUTE FUNCTION orders_sold_lands_as_done();

-- Any written between 0173 and the trigger.
UPDATE orders SET lifecycle = 'done' WHERE lifecycle = 'sold';
