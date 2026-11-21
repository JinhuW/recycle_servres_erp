-- Photos in Facebook chats, stored once (RS-589). Facebook's image links are
-- signed and expire, so the extension uploads each photo's bytes, Telegram
-- photo replies are downloaded, and every reader (the chats page, Telegram)
-- works from this copy. `sha256` is of the bytes as received, so a chat read
-- again with fresh signed links adds no rows.
--
-- `stub_bytes` holds the file only where R2 is not configured (dev, tests);
-- production refuses to store without R2.

CREATE TABLE fb_chat_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256      TEXT NOT NULL UNIQUE,
  source      TEXT NOT NULL CHECK (source IN ('facebook', 'telegram', 'erp')),
  storage_key TEXT NOT NULL,
  stub_bytes  BYTEA,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ids into fb_chat_media, in bubble order. `images` keeps the original links.
ALTER TABLE fb_chat_messages ADD COLUMN media JSONB NOT NULL DEFAULT '[]';
