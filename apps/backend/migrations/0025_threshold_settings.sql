-- Business-rule thresholds that were hardcoded in route handlers / the SPA.
-- Moved into workspace_settings so they are configurable and single-sourced:
--   low_margin_floor    – fraction; sell below this margin warns + notifies
--   target_margin       – fraction; Market maxBuy = avgSell × (1 - target)
--   low_health_pct      – percent; inventory health below this is "low"
--   upload_max_bytes    – attachment / evidence size cap
--   upload_allowed_mime – attachment MIME allow-list
-- Idempotent; values mirror the previous hardcoded constants exactly.

INSERT INTO workspace_settings (key, value) VALUES
  ('low_margin_floor',    '0.15'::jsonb),
  ('target_margin',       '0.30'::jsonb),
  ('low_health_pct',      '50'::jsonb),
  ('upload_max_bytes',    '10485760'::jsonb),
  ('upload_allowed_mime', '["application/pdf","image/png","image/jpeg","image/jpg"]'::jsonb)
ON CONFLICT (key) DO NOTHING;
