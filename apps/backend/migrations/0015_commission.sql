-- Tiered commission model + commission settings. Tables only — adopting tiers
-- in dashboard math is a separate, isolated decision (see plan Task 5.5).
-- main also keeps users.commission_rate (flat 0.075) from 0002_desktop.sql;
-- the two coexist until dashboard explicitly switches. Idempotent.

CREATE TABLE IF NOT EXISTS commission_tiers (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  floor_pct   NUMERIC(5,2) NOT NULL,
  rate        NUMERIC(5,2) NOT NULL,
  position    INT NOT NULL DEFAULT 0
);

-- Seed only when the table is empty. This is idempotent under main's
-- re-run-every-migration runner AND robust against a pre-existing
-- commission_tiers from a divergent branch that may lack the UNIQUE(label)
-- key (so we can't rely on ON CONFLICT here — the SERIAL id is the only
-- guaranteed key, and it would just duplicate rows).
INSERT INTO commission_tiers (label, floor_pct, rate, position)
SELECT v.label, v.floor_pct, v.rate, v.position
FROM (VALUES
  ('Base',           0, 2, 0),
  ('Tier 1',        25, 4, 1),
  ('Tier 2',        35, 6, 2),
  ('Top performer', 45, 9, 3)
) AS v(label, floor_pct, rate, position)
WHERE NOT EXISTS (SELECT 1 FROM commission_tiers);

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
