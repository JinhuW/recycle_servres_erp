-- 0018_customer_contact_address.sql
-- Structured contact + address on customers; drop credit_limit, terms,
-- and the now-unused payment_terms lookup table.

ALTER TABLE customers DROP COLUMN IF EXISTS credit_limit;
ALTER TABLE customers DROP COLUMN IF EXISTS terms;
ALTER TABLE customers DROP COLUMN IF EXISTS contact;          -- old email-only string
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS contact_name  TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS country       TEXT;

DROP TABLE IF EXISTS payment_terms;
