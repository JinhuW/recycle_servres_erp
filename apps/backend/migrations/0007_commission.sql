CREATE TABLE IF NOT EXISTS commission_tiers (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  floor_pct   NUMERIC(5,2) NOT NULL,
  rate        NUMERIC(5,2) NOT NULL,
  position    INT NOT NULL DEFAULT 0
);
INSERT INTO commission_tiers (label, floor_pct, rate, position) VALUES
  ('Base',           0,  2, 0),
  ('Tier 1',        25,  4, 1),
  ('Tier 2',        35,  6, 2),
  ('Top performer', 45,  9, 3)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS commission_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO commission_settings (key, value) VALUES
  ('pay_schedule', '"monthly"'::jsonb),
  ('manager_approval', 'true'::jsonb),
  ('hold_on_returns', 'true'::jsonb),
  ('draft_mode', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
