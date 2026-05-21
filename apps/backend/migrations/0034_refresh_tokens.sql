-- Rotating refresh-token store for cookie-based auth. token_hash is the
-- SHA-256 of the opaque refresh secret (the raw value is never stored).
-- family_id groups a rotation chain so reuse of a rotated token can revoke
-- the whole family (theft response). Idempotent — resetDb/migrate replay it.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   UUID NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_hash_idx   ON refresh_tokens(token_hash);
