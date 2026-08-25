-- PayPal payment evidence captured when a package is added: the screenshot
-- lives in R2 (key + public URL here), and the extracted transaction id is
-- copied onto the PO by create-po, where it stays editable.
ALTER TABLE packages ADD COLUMN paypal_txn_id TEXT;
ALTER TABLE packages ADD COLUMN payment_screenshot_key TEXT;
ALTER TABLE packages ADD COLUMN payment_screenshot_url TEXT;
ALTER TABLE orders   ADD COLUMN paypal_txn_id TEXT;
