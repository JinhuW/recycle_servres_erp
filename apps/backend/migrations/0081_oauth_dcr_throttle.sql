-- Dynamic Client Registration is unauthenticated by design (RFC 7591) and is
-- now open by default so Claude and ChatGPT can mint a client for a custom
-- connector. Record the registrant IP so /oauth/register can throttle per-IP,
-- and index the DCR rows so the windowed COUNT stays cheap as the table grows.
--
-- created_by IS NULL is already the marker for a self-registered client
-- (the admin path always stamps the manager's user id), so the partial index
-- covers exactly the rows the throttle counts.

ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS created_ip TEXT;

CREATE INDEX IF NOT EXISTS oauth_clients_dcr_recent_idx
  ON oauth_clients (created_at DESC)
  WHERE created_by IS NULL;
