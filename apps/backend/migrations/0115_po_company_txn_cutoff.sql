-- A company-paid PO must carry a payment transaction id before it can leave
-- Draft. The rule starts when this migration runs, so a PO already on file is
-- never stranded by a field nobody asked its purchaser for -- and each
-- environment grandfathers exactly the orders it had when the rule reached it.
--
-- to_jsonb(NOW()), not NOW()::text: JSONB renders a timestamptz as ISO-8601,
-- which Date parses per spec. The text cast yields Postgres' space-separated
-- form, which only V8's legacy parser accepts.
INSERT INTO workspace_settings (key, value)
VALUES ('po_company_txn_required_from', to_jsonb(NOW()))
ON CONFLICT (key) DO NOTHING;
