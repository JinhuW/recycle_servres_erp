-- Chat bridge extensions enroll themselves. An extension with no
-- device asks POST /api/fb-chat/enroll, gets an id, a token and a pairing
-- code, and waits as 'pending' until a manager approves it on Settings ▸ Chat
-- bridge. Only the token's sha256 is kept. The bearer it sends is
-- fbd_<id>_<token>; the push routes take it in place of a fbchat:write
-- service-client token.
--
-- Not OAuth clients: the nightly prod → dev sync revokes every OAuth client,
-- while this table is set aside and put back (deploy/railway-sync).

CREATE TABLE fb_chat_devices (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  code         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  label        TEXT NOT NULL DEFAULT '',
  fb_uid       TEXT,
  ext_version  TEXT,
  created_ip   TEXT,
  ip_key       TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at   TIMESTAMPTZ
);
CREATE INDEX fb_chat_devices_decided_by_idx ON fb_chat_devices(decided_by);
-- The enroll route counts recent rows per address and pending rows overall.
CREATE INDEX fb_chat_devices_ip_key_idx ON fb_chat_devices(ip_key, created_at);
CREATE INDEX fb_chat_devices_pending_idx ON fb_chat_devices(created_at) WHERE status = 'pending';
