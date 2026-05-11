CREATE TABLE IF NOT EXISTS workspace_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO workspace_settings (key, value) VALUES
  ('workspace_name', '"Recycle Servers"'::jsonb),
  ('domain',         '"recycleservers.io"'::jsonb),
  ('currency',       '"USD"'::jsonb),
  ('fiscal_start',   '"January"'::jsonb),
  ('timezone',       '"America/Los_Angeles"'::jsonb),
  ('fx_auto',        'true'::jsonb),
  ('week_start',     '"Monday"'::jsonb),
  ('notify_new_order',     'true'::jsonb),
  ('notify_weekly_digest', 'true'::jsonb),
  ('notify_low_margin',    'true'::jsonb),
  ('notify_capacity',      'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
