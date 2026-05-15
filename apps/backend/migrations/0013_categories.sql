-- Order/inventory categories with per-category capture rules. Backs the real
-- /api/categories endpoint (replaces the client-side hard-coded list in
-- DesktopSettings). Idempotent.

CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  icon            TEXT NOT NULL DEFAULT 'box',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  ai_capture      BOOLEAN NOT NULL DEFAULT FALSE,
  requires_pn     BOOLEAN NOT NULL DEFAULT FALSE,
  default_margin  NUMERIC(5,2) NOT NULL DEFAULT 30.0,
  position        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HDD is a first-class category on main (see 0007_disk_health_and_hdd.sql);
-- the upstream parallel seed predated it, so it is added here.
INSERT INTO categories (id, label, icon, enabled, ai_capture, requires_pn, default_margin, position) VALUES
  ('RAM',   'RAM',   'chip',  TRUE,  TRUE,  TRUE,  38.0, 0),
  ('SSD',   'SSD',   'drive', TRUE,  FALSE, TRUE,  28.0, 1),
  ('HDD',   'HDD',   'drive', TRUE,  FALSE, TRUE,  25.0, 2),
  ('Other', 'Other', 'box',   TRUE,  FALSE, FALSE, 22.0, 3),
  ('CPU',   'CPU',   'chip',  FALSE, FALSE, TRUE,  30.0, 4),
  ('GPU',   'GPU',   'chip',  FALSE, FALSE, TRUE,  35.0, 5)
ON CONFLICT (id) DO NOTHING;
