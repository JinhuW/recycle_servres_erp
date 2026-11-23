-- Provider API keys pushed by the ERP (Settings ▸ AI models), so a key can be
-- rotated without a redeploy. Env keys still fill any provider with no row.
--
-- Not in `settings`: GET /api/settings returns every settings row, and these
-- must never be read back out. Plain text, the same trust level as the
-- Railway env vars they replace.
CREATE TABLE IF NOT EXISTS llm_keys (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('openrouter', 'anthropic', 'openai')),
  api_key    TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
