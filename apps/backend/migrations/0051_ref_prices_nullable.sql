-- Relax NOT NULL on the market-tracking price columns so a part can be
-- tracked before it has any price data. Auto-tracking on PO intake
-- (routes/orders.ts) seeds rows with identifying specs only; the scraper
-- fills prices later via applyMarketWrites.

ALTER TABLE ref_prices
  ALTER COLUMN target     DROP NOT NULL,
  ALTER COLUMN low_price  DROP NOT NULL,
  ALTER COLUMN high_price DROP NOT NULL,
  ALTER COLUMN avg_sell   DROP NOT NULL;
