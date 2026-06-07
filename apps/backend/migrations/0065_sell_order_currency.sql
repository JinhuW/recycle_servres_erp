-- Per-order currency on sell orders. Mirrors the vendor_bids currency columns
-- (0056_multi_currency.sql): a sell order is quoted in one currency, every line
-- shares it, and the FX rate is frozen on the header at save. Line USD values
-- still live in sell_order_lines.unit_price so all downstream reporting stays
-- USD — the native facts live in the line audit columns added by 0056
-- (source_currency / source_unit_price / source_fx_rate_to_usd).
--
-- Supersedes the "SO denomination: USD-only" decision in the multi-currency
-- vendor-bids design; see docs/superpowers/specs/2026-06-07-sell-order-currency-design.md.

ALTER TABLE sell_orders
  ADD COLUMN currency_code  CHAR(3)       NOT NULL DEFAULT 'USD',
  ADD COLUMN fx_rate_to_usd NUMERIC(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN fx_source      TEXT          NOT NULL DEFAULT 'manual';

ALTER TABLE sell_orders
  ADD CONSTRAINT sell_orders_currency_ck CHECK (currency_code IN ('USD','CNY'));
