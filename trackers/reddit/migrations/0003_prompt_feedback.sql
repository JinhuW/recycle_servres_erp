-- Prompt feedback: which prompt judged each post, where every alert landed in
-- Telegram, and how people reacted to it. Together they turn "is the prompt
-- any good?" into a query (GET /api/prompt-stats) instead of a guess.

-- A version is the exact (model, system prompt) pair a verdict came from,
-- keyed by hash, so a prompt that is edited back to earlier wording counts as
-- the earlier version again rather than a new one.
CREATE TABLE IF NOT EXISTS prompt_versions (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash          TEXT NOT NULL UNIQUE,
  model         TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  first_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NULL for every verdict made before versioning existed.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS prompt_version_id INT REFERENCES prompt_versions (id);

CREATE INDEX IF NOT EXISTS idx_posts_prompt_version
  ON posts (prompt_version_id) WHERE prompt_version_id IS NOT NULL;

-- Verdicts from the prompt on trial (the candidate_eval_prompt setting). They
-- never change a post's status: the candidate can reach the dev chat, never
-- the buyers.
CREATE TABLE IF NOT EXISTS candidate_verdicts (
  reddit_id         TEXT NOT NULL REFERENCES posts (reddit_id) ON DELETE CASCADE,
  prompt_version_id INT NOT NULL REFERENCES prompt_versions (id),
  is_target         BOOLEAN NOT NULL,
  summary           TEXT NOT NULL,
  price             TEXT,
  reasoning         TEXT NOT NULL,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reddit_id, prompt_version_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_verdicts_version
  ON candidate_verdicts (prompt_version_id);

-- Every Telegram message an alert or review went out as. Reactions arrive
-- keyed by (chat, message) only, so this is the one way back to the post.
CREATE TABLE IF NOT EXISTS alert_messages (
  chat_id    TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  reddit_id  TEXT NOT NULL REFERENCES posts (reddit_id) ON DELETE CASCADE,
  audience   TEXT NOT NULL CHECK (audience IN ('buyers', 'dev')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_alert_messages_post ON alert_messages (reddit_id);

-- Every reaction update Telegram delivered, verbatim and append-only: the
-- long-term source data, interpreted only by the tables below. Not joined to
-- alert_messages on write, so a reaction on an alert sent before the ledger
-- existed is kept and counted as unmatched.
CREATE TABLE IF NOT EXISTS reaction_events (
  update_id   BIGINT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  message_id  BIGINT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Current reaction per (message, reactor) in a group, where Telegram names
-- who reacted. `emoji` is what the reactor has on the message NOW; a removed
-- reaction leaves '[]' and keeps the row.
CREATE TABLE IF NOT EXISTS message_reactions (
  chat_id          TEXT NOT NULL,
  message_id       BIGINT NOT NULL,
  reactor          TEXT NOT NULL,  -- user id, or chat:<id> for an anonymous admin
  reactor_name     TEXT,
  emoji            JSONB NOT NULL DEFAULT '[]',
  first_reacted_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_id, message_id, reactor)
);

-- Current totals per message in a channel, where reactions are anonymous and
-- Telegram only reports counts ({"👍": 3}).
CREATE TABLE IF NOT EXISTS message_reaction_counts (
  chat_id    TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  counts     JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- The getUpdates cursor, so a restart resumes instead of replaying.
CREATE TABLE IF NOT EXISTS telegram_state (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  next_offset BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO telegram_state (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- What a message's reactions say about its alert. 👎 is the one reaction that
-- means "should not have alerted"; anything else (👍, 🔥, a custom emoji, a
-- paid star) means someone found it worth acting on — a lead.
CREATE OR REPLACE VIEW message_labels AS
  WITH reacted AS (
    SELECT r.chat_id, r.message_id, e.emoji, 1 AS n
      FROM message_reactions r, jsonb_array_elements_text(r.emoji) AS e(emoji)
    UNION ALL
    SELECT c.chat_id, c.message_id, kv.key, kv.value::int
      FROM message_reaction_counts c, jsonb_each_text(c.counts) AS kv(key, value)
     WHERE kv.value::int > 0
  )
  SELECT chat_id, message_id,
         bool_or(emoji <> '👎') AS positive,
         bool_or(emoji = '👎') AS negative,
         SUM(n)::int AS reactions
    FROM reacted
   GROUP BY chat_id, message_id;

-- Empty means off: no dev chat, no prompt on trial, candidate uses llm_model.
INSERT INTO settings (key, value) VALUES
  ('telegram_dev_chat_ids', '[]'::jsonb),
  ('candidate_eval_prompt', to_jsonb(''::text)),
  ('candidate_llm_model',   to_jsonb(''::text))
ON CONFLICT (key) DO NOTHING;
