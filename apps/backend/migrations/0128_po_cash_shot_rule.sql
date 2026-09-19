-- A third proof-of-payment rule: a company-paid PO settled in cash must carry
-- a screenshot of the amount handed over before it leaves Draft. Cash proof
-- gets its own status-meta bucket, 'Payment', so the rule counts only files
-- offered as proof — Submission holds receipts, manifests and spreadsheets,
-- any of which would otherwise satisfy it.

ALTER TABLE order_status_meta
  DROP CONSTRAINT order_status_meta_status_check,
  ADD  CONSTRAINT order_status_meta_status_check
    CHECK (status IN ('Submission', 'Done', 'Payment'));

ALTER TABLE order_status_attachments
  DROP CONSTRAINT order_status_attachments_status_check,
  ADD  CONSTRAINT order_status_attachments_status_check
    CHECK (status IN ('Submission', 'Done', 'Payment'));

-- Stamped when the rule reaches each environment, like 0115 / 0126: orders
-- already on file are exempt, and an absent key means the rule is off.
INSERT INTO workspace_settings (key, value)
VALUES ('po_cash_shot_required_from', to_jsonb(NOW()))
ON CONFLICT (key) DO NOTHING;
