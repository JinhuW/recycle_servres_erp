-- Who saw each buyer alert. Telegram reports a message's readers only to the
-- user account that sent it, and only in groups of up to 100 members for 7
-- days, so alerts the api sends as a user collect reads and bot alerts never
-- do (src/userSender.ts, src/loops/reads.ts).

ALTER TABLE alert_messages
  ADD COLUMN IF NOT EXISTS sent_as TEXT NOT NULL DEFAULT 'bot' CHECK (sent_as IN ('bot', 'user'));

CREATE TABLE IF NOT EXISTS message_reads (
  chat_id    TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  user_id    TEXT NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_id, message_id, user_id),
  FOREIGN KEY (chat_id, message_id) REFERENCES alert_messages (chat_id, message_id) ON DELETE CASCADE
);

-- The buyer chats' people, so the Seen tab can also list who saw nothing.
-- left_at is set when a refresh no longer finds them.
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  username   TEXT,
  left_at    TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

-- Renewed by the api while its user session is up. Workers leave buyer alerts
-- to it while this is fresh, and take over with the bot once it goes stale.
ALTER TABLE telegram_state ADD COLUMN IF NOT EXISTS user_sender_at TIMESTAMPTZ;
