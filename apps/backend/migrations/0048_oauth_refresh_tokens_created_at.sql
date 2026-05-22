-- Add created_at so the Connectors UI can show last_used_at per client
-- (= MAX(created_at) of live refresh tokens). Existing rows backfill to NOW().
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
