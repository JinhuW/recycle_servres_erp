-- Seller self-service fill: a shipment can now be created as an empty shell
-- whose address and package the seller enters through a tokenized public link
-- (/s/<token>, same idea as the vendor portal). The from-address and package
-- columns therefore lose their NOT NULLs; completeness is enforced where it
-- matters — the rates and buy routes refuse an incomplete shipment.

ALTER TABLE shipments
  ALTER COLUMN from_name    DROP NOT NULL,
  ALTER COLUMN from_street1 DROP NOT NULL,
  ALTER COLUMN from_city    DROP NOT NULL,
  ALTER COLUMN from_state   DROP NOT NULL,
  ALTER COLUMN from_zip     DROP NOT NULL,
  ALTER COLUMN from_country DROP NOT NULL,
  ALTER COLUMN weight_oz    DROP NOT NULL,
  ALTER COLUMN length_in    DROP NOT NULL,
  ALTER COLUMN width_in     DROP NOT NULL,
  ALTER COLUMN height_in    DROP NOT NULL;

-- Token lookups come from the public route; misses must be uniform 404s.
CREATE UNIQUE INDEX shipments_seller_token_idx
  ON shipments(seller_token) WHERE seller_token IS NOT NULL;
