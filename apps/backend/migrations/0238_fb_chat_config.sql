-- Settings for the chat bridge extensions, set on Settings ▸ Chat bridge. An
-- extension's options page holds only what it takes to reach the ERP; it asks
-- here for the rest.
--
-- Keys are not a fixed list. Each extension reports the fields it understands
-- (fb_chat_config_fields), the page draws its form from them, and a value is
-- any JSON. account_id NULL is the value for every profile; a row for an
-- account overrides it for that profile.

CREATE TABLE fb_chat_config (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES fb_chat_accounts(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (account_id, key)
);
-- account_id is the leading column of the unique index above.
CREATE INDEX fb_chat_config_updated_by_idx ON fb_chat_config(updated_by);

-- The fields each extension version reports, as it reported them.
CREATE TABLE fb_chat_config_fields (
  ext_version   TEXT PRIMARY KEY,
  fields        JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The settings revision each profile last picked up, so the page can say
-- whether a change has arrived.
ALTER TABLE fb_chat_accounts
  ADD COLUMN config_rev     TEXT,
  ADD COLUMN config_seen_at TIMESTAMPTZ;
