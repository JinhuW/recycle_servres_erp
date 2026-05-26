-- Multi-currency vendor bids: USD remains the company's reporting currency,
-- but vendors may quote in CNY (RMB). A ledger of FX rates feeds a frozen
-- snapshot on each vendor_bid (at submit) and again on each sell_order_line
-- (at promote). Sell-order totals stay USD; source-currency facts live in
-- audit columns so SO history can show the original quote.

CREATE TABLE IF NOT EXISTS fx_rates (
  id              BIGSERIAL PRIMARY KEY,
  base_currency   CHAR(3)       NOT NULL,
  quote_currency  CHAR(3)       NOT NULL,
  rate            NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  source          TEXT          NOT NULL,
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  effective_date  DATE          NOT NULL,
  note            TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (base_currency IN ('USD')),
  CHECK (quote_currency IN ('CNY')),
  CHECK (source IN ('frankfurter','manual'))
);
CREATE INDEX IF NOT EXISTS fx_rates_pair_fetched
  ON fx_rates (base_currency, quote_currency, fetched_at DESC);

ALTER TABLE vendor_bids
  ADD COLUMN IF NOT EXISTS currency_code  CHAR(3)       NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS fx_rate_to_usd NUMERIC(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_source      TEXT          NOT NULL DEFAULT 'manual';

ALTER TABLE vendor_bids
  DROP CONSTRAINT IF EXISTS vendor_bids_currency_ck;
ALTER TABLE vendor_bids
  ADD CONSTRAINT vendor_bids_currency_ck CHECK (currency_code IN ('USD','CNY'));

ALTER TABLE sell_order_lines
  ADD COLUMN IF NOT EXISTS source_currency       CHAR(3),
  ADD COLUMN IF NOT EXISTS source_unit_price     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS source_fx_rate_to_usd NUMERIC(18,8);
