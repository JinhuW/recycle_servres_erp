-- Facebook chat hub: a Chrome extension in each of the owner's browser
-- profiles reads its Marketplace inbox and pushes it here. The backend mirrors
-- every conversation into one Telegram forum topic per buyer and hands replies
-- typed in a topic back to the extension that owns the conversation.
--
-- Kept apart from fb_threads / fb_messages on purpose: those belong to the
-- fleet's seller accounts, where an agent may answer. Nothing here is read by
-- the pacing tick or the agent. Accounts are keyed by the Facebook uid, which
-- is also fb_pool_accounts.uid, so the two can be joined.

CREATE TABLE fb_chat_accounts (
  id            BIGSERIAL PRIMARY KEY,
  fb_uid        TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  -- The service client that last spoke for this account.
  client_id     TEXT,
  ext_version   TEXT,
  -- 'login' or 'checkpoint' while the extension sees one; NULL when healthy.
  restricted    TEXT CHECK (restricted IN ('login','checkpoint')),
  restricted_at TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per Marketplace profile, shared by every account it writes to, so a
-- repeat buyer is recognised across accounts.
CREATE TABLE fb_chat_buyers (
  id            BIGSERIAL PRIMARY KEY,
  fb_profile_id TEXT NOT NULL UNIQUE,
  name          TEXT,
  location      TEXT,
  joined_year   INTEGER,
  rating        NUMERIC(2,1) CHECK (rating BETWEEN 0 AND 5),
  rating_count  INTEGER CHECK (rating_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fb_chat_threads (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES fb_chat_accounts(id) ON DELETE CASCADE,
  fb_thread_id       TEXT NOT NULL,
  buyer_id           BIGINT REFERENCES fb_chat_buyers(id) ON DELETE SET NULL,
  -- As the thread showed them; kept here because a thread may never reveal
  -- the buyer's profile id.
  buyer_name         TEXT,
  buyer_location     TEXT,
  listing_id         TEXT,
  listing_title      TEXT,
  telegram_topic_id  BIGINT,
  telegram_topic_name TEXT,
  -- The header message is posted once, right after the topic is created.
  header_sent_at     TIMESTAMPTZ,
  last_seq           INTEGER NOT NULL DEFAULT 0,
  -- The extension has scrolled to the start of the conversation.
  history_complete   BOOLEAN NOT NULL DEFAULT FALSE,
  last_inbound_at    TIMESTAMPTZ,
  last_outbound_at   TIMESTAMPTZ,
  last_synced_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, fb_thread_id)
);
CREATE INDEX fb_chat_threads_buyer_idx ON fb_chat_threads(buyer_id);
CREATE UNIQUE INDEX fb_chat_threads_topic_idx ON fb_chat_threads(telegram_topic_id)
  WHERE telegram_topic_id IS NOT NULL;

CREATE TABLE fb_chat_messages (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES fb_chat_threads(id) ON DELETE CASCADE,
  -- Position in the conversation. NULL while a Telegram reply has not been
  -- seen on Facebook yet.
  seq           INTEGER,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  -- Where the text was written: on Facebook, or in the Telegram topic.
  source        TEXT NOT NULL CHECK (source IN ('facebook','telegram')),
  body          TEXT NOT NULL DEFAULT '',
  images        JSONB NOT NULL DEFAULT '[]',
  -- Part of the history read when the thread was first seen, not a live event:
  -- its created_at is when it was read, not when it was written.
  backfill      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Telegram replies only.
  send_state    TEXT CHECK (send_state IN ('queued','sending','sent','failed','uncertain')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  typing_ms     INTEGER,
  claimed_at    TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  tg_message_id BIGINT,
  tg_user_id    BIGINT,
  tg_user_name  TEXT,
  -- Set once Telegram has been told the outcome of a reply.
  acked_at      TIMESTAMPTZ,
  -- Set once the message is in the topic. Telegram replies are born mirrored.
  mirrored_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (thread_id, seq),
  UNIQUE (thread_id, tg_message_id)
);
CREATE INDEX fb_chat_messages_unmirrored_idx ON fb_chat_messages(id) WHERE mirrored_at IS NULL;
CREATE INDEX fb_chat_messages_outbox_idx ON fb_chat_messages(thread_id, id)
  WHERE send_state IN ('queued','sending');
CREATE INDEX fb_chat_messages_unacked_idx ON fb_chat_messages(id)
  WHERE send_state IN ('sent','failed','uncertain') AND acked_at IS NULL;

-- Everything worth counting later that is not itself a message: syncs, sends
-- and their failures, restrictions, rating changes, Telegram errors.
CREATE TABLE fb_chat_events (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES fb_chat_accounts(id) ON DELETE CASCADE,
  thread_id  BIGINT REFERENCES fb_chat_threads(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  -- Posted to the group's General topic when set and not yet announced.
  alert      TEXT,
  alerted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_chat_events_account_idx ON fb_chat_events(account_id, created_at);
CREATE INDEX fb_chat_events_thread_idx ON fb_chat_events(thread_id);
CREATE INDEX fb_chat_events_alert_idx ON fb_chat_events(id) WHERE alert IS NOT NULL AND alerted_at IS NULL;

-- The getUpdates cursor. One row.
CREATE TABLE fb_chat_telegram_state (
  id      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  "offset" BIGINT NOT NULL DEFAULT 0
);
INSERT INTO fb_chat_telegram_state DEFAULT VALUES;
