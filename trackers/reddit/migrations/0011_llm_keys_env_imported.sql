-- Which providers' env keys have been copied into llm_keys. The copy runs at
-- boot, at most once per provider: a key the ERP later removes (DELETE
-- /api/llm-keys/:provider deletes only the llm_keys row) must not come back
-- from an env var nobody deleted. After that the env vars are not read.
CREATE TABLE IF NOT EXISTS llm_keys_env_imported (
  provider    TEXT PRIMARY KEY CHECK (provider IN ('openrouter', 'anthropic', 'openai')),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
