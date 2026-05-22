-- OAuth 2.1 minimal AS for the market-value MCP + scraper write endpoint.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT,
  name          TEXT NOT NULL,
  redirect_uris TEXT[] NOT NULL,
  grant_types   TEXT[] NOT NULL,
  scopes        TEXT[] NOT NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_idx
  ON oauth_authorization_codes (expires_at);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_client_idx
  ON oauth_authorization_codes (client_id);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_user_idx
  ON oauth_authorization_codes (user_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  token_hash  TEXT UNIQUE NOT NULL,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  scopes      TEXT[] NOT NULL,
  family_id   UUID NOT NULL,
  parent_id   BIGINT REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_idx
  ON oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx
  ON oauth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_idx
  ON oauth_refresh_tokens (client_id);
