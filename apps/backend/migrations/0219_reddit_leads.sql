-- Reddit leads: sellers with confirmed trades in the swap subreddits' bot
-- records (u/LabB0T on r/homelabsales, u/hwsbot on r/hardwareswap), loaded by
-- a manager from a harvest file. Purchasers claim a seller and work it from
-- first DM to a deal; the stage, follow-up and history are theirs and the
-- managers', never the other purchasers'.
--
-- `username` is the Reddit name lower-cased, because Reddit names are
-- case-insensitive and the harvest spells one seller several ways;
-- display_name keeps the spelling the bot used last.

CREATE TABLE reddit_leads (
  username        TEXT PRIMARY KEY CHECK (username = lower(username) AND username ~ '^[a-z0-9_-]{2,30}$'),
  display_name    TEXT NOT NULL,
  sales           INTEGER NOT NULL DEFAULT 0 CHECK (sales >= 0),
  buys            INTEGER NOT NULL DEFAULT 0 CHECK (buys >= 0),
  record_source   TEXT NOT NULL DEFAULT '',
  subreddits      TEXT[] NOT NULL DEFAULT '{}',
  last_deal       DATE,
  items_sold      TEXT[] NOT NULL DEFAULT '{}',
  latest_post_title TEXT NOT NULL DEFAULT '',
  latest_post_url TEXT NOT NULL DEFAULT '',
  tracker_alerts  INTEGER NOT NULL DEFAULT 0,
  claimed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_name    TEXT,
  claimed_at      TIMESTAMPTZ,
  -- The pipeline. Closing keeps the stage reached and sets `closed`; a deal
  -- is the last stage, not a closing reason.
  stage           TEXT NOT NULL DEFAULT 'claimed'
                  CHECK (stage IN ('claimed','dm','replied','talks','won')),
  closed          TEXT NOT NULL DEFAULT '' CHECK (closed IN ('','nostock','lost')),
  follow_up       DATE,
  dm_at           TIMESTAMPTZ,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX reddit_leads_claimed_by_idx ON reddit_leads(claimed_by);
CREATE INDEX reddit_leads_sales_idx      ON reddit_leads(sales DESC);

-- Top buyers and who they bought from: the Buyer network tab's tree. Rebuilt
-- by every import, so it holds no state of its own.
CREATE TABLE reddit_lead_buyers (
  username     TEXT PRIMARY KEY CHECK (username = lower(username)),
  display_name TEXT NOT NULL,
  buys         INTEGER NOT NULL DEFAULT 0,
  sales        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE reddit_lead_trades (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer      TEXT NOT NULL REFERENCES reddit_lead_buyers(username) ON DELETE CASCADE,
  seller     TEXT NOT NULL,
  item       TEXT NOT NULL DEFAULT '',
  traded_on  DATE,
  url        TEXT NOT NULL DEFAULT '',
  subreddit  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX reddit_lead_trades_buyer_idx  ON reddit_lead_trades(buyer);
CREATE INDEX reddit_lead_trades_seller_idx ON reddit_lead_trades(seller);

-- Who did what to which seller, including the replies purchasers log. No FK
-- on username: a seller dropped by a later import keeps its history.
CREATE TABLE reddit_lead_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username    TEXT,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('imported','claimed','released','dm','reply',
                                           'stage','follow_up','closed','reopened')),
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX reddit_lead_events_username_idx ON reddit_lead_events(username, created_at);
CREATE INDEX reddit_lead_events_actor_id_idx ON reddit_lead_events(actor_id);

-- Append-only, the same way as fb_pool_events (0182).
CREATE OR REPLACE FUNCTION reddit_lead_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reddit_lead_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reddit_lead_events_no_update BEFORE UPDATE ON reddit_lead_events
  FOR EACH ROW EXECUTE FUNCTION reddit_lead_events_lock();
CREATE TRIGGER reddit_lead_events_no_delete BEFORE DELETE ON reddit_lead_events
  FOR EACH ROW EXECUTE FUNCTION reddit_lead_events_lock();
