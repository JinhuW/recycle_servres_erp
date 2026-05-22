-- Parked OAuth authorize requests, handed off to the SPA via opaque handle.
-- Keeps long PKCE challenges out of the URL on the consent screen.

CREATE TABLE IF NOT EXISTS oauth_pending_consent (
  req                  TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri         TEXT NOT NULL,
  scopes               TEXT[] NOT NULL,
  code_challenge       TEXT NOT NULL,
  state                TEXT,
  expires_at           TIMESTAMPTZ NOT NULL,
  user_id_from_cookie  UUID  -- informational only
);
CREATE INDEX IF NOT EXISTS oauth_pending_consent_expires_idx
  ON oauth_pending_consent (expires_at);
CREATE INDEX IF NOT EXISTS oauth_pending_consent_client_idx
  ON oauth_pending_consent (client_id);
