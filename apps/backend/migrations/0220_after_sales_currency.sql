-- A case's refund or discount is in its own currency now: RMB buyers are
-- refunded in RMB. amount is native to currency_code; existing cases stay USD.
ALTER TABLE after_sales_cases
  ADD COLUMN currency_code CHAR(3) NOT NULL DEFAULT 'USD'
    CHECK (currency_code IN ('USD', 'CNY'));
