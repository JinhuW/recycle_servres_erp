-- A key removed on Settings ▸ AI models whose removal hasn't reached the
-- Reddit tracker yet. The key's own row is gone, so without this nothing
-- would record that the tracker still holds it: the page shows the row as
-- unsynced and offers a retry until the tracker confirms. Saving a new key
-- for the provider supersedes it.

CREATE TABLE ai_provider_key_removals (
  provider     TEXT PRIMARY KEY CHECK (provider IN ('openrouter', 'anthropic', 'openai')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
