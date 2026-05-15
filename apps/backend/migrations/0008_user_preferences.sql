-- Per-user, server-backed UI preferences (column visibility, density,
-- role-preview, language, etc). One JSONB column holding a flat, namespaced
-- key->value map. Adding a new preference is a code-only change — no schema
-- migration per key.
--
-- Keys currently in use (validated by an allowlist in src/routes/me.ts):
--   language                    "en" | "zh"
--   tweaks.density              "comfortable" | "compact"
--   tweaks.rolePreview          "actual" | "as_purchaser"  (manager-only)
--   inventory.cols.manager      string[]
--   inventory.cols.purchaser    string[]
--   orders.cols                 string[]

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Lift the existing language column into preferences so the new endpoint is
-- the source of truth. users.language stays for one release as a fallback;
-- it can be dropped once nothing reads it directly.
UPDATE users
   SET preferences = jsonb_set(preferences, '{language}', to_jsonb(language), true)
 WHERE NOT (preferences ? 'language');
