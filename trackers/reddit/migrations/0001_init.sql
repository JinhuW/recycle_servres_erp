-- Distributed Reddit for-sale tracker: coordination + dedup schema.
-- Postgres is the ONLY thing shared between worker VMs: it schedules polls,
-- deduplicates posts fleet-wide, and stores runtime config.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Business config lives here so it can change without a redeploy. Secrets
-- (DB URL, API keys, bot token) stay in env and never land in this table.
INSERT INTO settings (key, value) VALUES
  ('eval_prompt', to_jsonb($prompt$You are a purchasing agent for Recycle Servers LLC, a used-server hardware reseller in Denver, CO.

Given a Reddit post, decide whether it is a FOR-SALE listing of hardware we want to buy.

We buy: used rack servers and complete systems, server CPUs (Xeon/EPYC), ECC RAM (DDR3/DDR4/DDR5), enterprise SSDs and HDDs, RAID/HBA controllers, server NICs, GPUs, PSUs, rails, switches, and other rack/datacenter gear.

Reject the post when any of these is true:
- The author is BUYING, trading for something else, or asking for advice/help.
- It is a discussion, build log, review, or meme rather than a listing.
- The item is consumer gear with no resale value to us (peripherals, cases, laptops, phones).
- The listing is already marked sold or closed.

If it is a target, write a one-to-two sentence summary a buyer can act on: what the item is, quantity, condition, and location if stated.$prompt$::text)),
  ('llm_model',          to_jsonb('openai/gpt-4o-mini'::text)),
  ('telegram_chat_ids',  '[]'::jsonb),
  ('max_post_age_hours', to_jsonb(24))
ON CONFLICT (key) DO NOTHING;

-- One row per watched subreddit. Doubles as the fleet scheduler: workers
-- claim due rows with FOR UPDATE SKIP LOCKED so no two workers ever fetch
-- the same subreddit at the same time.
CREATE TABLE IF NOT EXISTS subreddits (
  name                  TEXT PRIMARY KEY,          -- lowercase, no "r/" prefix
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  poll_interval_seconds INT NOT NULL DEFAULT 90 CHECK (poll_interval_seconds >= 30),
  next_poll_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by            TEXT,
  claimed_at            TIMESTAMPTZ,
  last_polled_at        TIMESTAMPTZ,
  last_status           TEXT,
  consecutive_errors    INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subreddits_due
  ON subreddits (next_poll_at) WHERE enabled;

INSERT INTO subreddits (name) VALUES
  ('homelabsales'), ('hardwareswap'), ('homelab'), ('datahoarder')
ON CONFLICT (name) DO NOTHING;

-- One row per Reddit post ever seen. The primary key IS the dedup mechanism:
-- every worker inserts what it fetched with ON CONFLICT DO NOTHING, so a post
-- is evaluated and alerted exactly once no matter how many workers saw it.
CREATE TABLE IF NOT EXISTS posts (
  reddit_id     TEXT PRIMARY KEY,                  -- fullname, e.g. 't3_1abcde'
  subreddit     TEXT NOT NULL,
  title         TEXT NOT NULL,
  selftext      TEXT NOT NULL DEFAULT '',
  author        TEXT,
  flair         TEXT,
  url           TEXT NOT NULL,
  posted_at     TIMESTAMPTZ NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'rejected', 'target', 'notified', 'failed')),
  is_target     BOOLEAN,
  llm_summary   TEXT,
  llm_price     TEXT,
  llm_raw       JSONB,
  reject_reason TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by    TEXT,
  claimed_at    TIMESTAMPTZ,
  notified_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_posts_pending_eval
  ON posts (next_retry_at) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_posts_pending_notify
  ON posts (next_retry_at) WHERE status = 'target';
CREATE INDEX IF NOT EXISTS idx_posts_targets
  ON posts (discovered_at DESC) WHERE is_target;
