-- Workspace-level fallback margin applied to a new category when no explicit
-- defaultMargin is provided. Replaces the literal `?? 30` in routes/categories.ts
-- so the fallback is configurable via /api/workspace. Idempotent.

INSERT INTO workspace_settings (key, value) VALUES
  ('category_default_margin', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
