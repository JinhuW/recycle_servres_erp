-- Per-payment-type commission rates (Company pay / Self pay). The two payment
-- types are fixed by design — only their rates are configurable. Previously the
-- Commission settings panel hardcoded 50 / 65 client-side and the Save button
-- was a no-op; these keys make the rates DB-backed via the existing generic
-- /api/commission/settings key-value endpoint. Idempotent.

INSERT INTO commission_settings (key, value) VALUES
  ('rate_company', '50'::jsonb),
  ('rate_self',    '65'::jsonb)
ON CONFLICT (key) DO NOTHING;
