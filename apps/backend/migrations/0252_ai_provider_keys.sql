-- AI provider API keys pasted on Settings ▸ AI models. A row wins over the
-- provider's env var. `sealed` is lib/sealed.ts output under a key derived
-- from FB_POOL_KEY; `last4` is all the page ever shows of it.

CREATE TABLE ai_provider_keys (
  provider    TEXT PRIMARY KEY CHECK (provider IN ('openrouter', 'anthropic', 'openai')),
  sealed      TEXT NOT NULL,
  last4       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Whether the last write reached the Reddit tracker; the page offers a retry when not.
  tracker_synced BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX ai_provider_keys_updated_by_idx ON ai_provider_keys(updated_by);
