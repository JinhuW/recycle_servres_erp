-- WeChat market: the daily memory-module report memtrade builds from the
-- team's WeChat trading groups (an outside tool on the office Mac). It pushes
-- each report day here once its 08:00 ET run is done, and again whenever it
-- redoes a day, so a push replaces the whole day. Read-only for the ERP:
-- nothing here touches ref_prices or any order.

CREATE TABLE wechat_market_days (
  report_date     DATE PRIMARY KEY,
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  -- Claude was unavailable and memtrade parsed the day with its rules.
  -- It pushes the day again once it has redone it.
  degraded        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Claude's market notes, markdown bullets; NULL when that call failed.
  summary         TEXT,
  warnings        TEXT[] NOT NULL DEFAULT '{}',
  messages        INT NOT NULL,
  groups_total    INT NOT NULL,
  groups_active   INT NOT NULL,
  candidates      INT NOT NULL,
  posts           INT NOT NULL,
  buy_posts       INT NOT NULL,
  sell_posts      INT NOT NULL,
  buyers          INT NOT NULL,
  sellers         INT NOT NULL,
  -- The evidence arrives in batches after the day itself; fewer stored
  -- points than this means a push stopped part-way.
  point_count     INT NOT NULL,
  pushed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (window_end > window_start)
);

-- One row per report line and day. `kind` is the row family memtrade counts
-- by: spec "64G 5600", code "32G DM0" (the traders' shorthand), and quote
-- "三星 64G 5600 DM0" (brand x capacity x speed x short code, the price board).
-- Both sides sit on one row because the page always shows them side by side.
CREATE TABLE wechat_market_rows (
  report_date     DATE NOT NULL REFERENCES wechat_market_days(report_date) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('spec', 'code', 'quote')),
  row_key         TEXT NOT NULL,
  brand           TEXT,
  capacity_gb     INT,
  speed           INT,
  code            TEXT,
  ddr             TEXT,
  form_factor     TEXT CHECK (form_factor IN ('server', 'pc')),
  ranks           TEXT[] NOT NULL DEFAULT '{}',
  part_numbers    TEXT[] NOT NULL DEFAULT '{}',
  signal          TEXT,
  buy_posts       INT NOT NULL,
  buy_senders     INT NOT NULL,
  buy_groups      INT NOT NULL,
  buy_exposures   INT NOT NULL,
  buy_qty         INT NOT NULL,
  -- [{bucket, n, min, median, max, approx, outliers}], most quotes first.
  -- A bucket is a currency and tax basis (RMB含税, RMB未税, RMB, USD); prices
  -- in different buckets are never compared.
  buy_prices      JSONB NOT NULL DEFAULT '[]',
  sell_posts      INT NOT NULL,
  sell_senders    INT NOT NULL,
  sell_groups     INT NOT NULL,
  sell_exposures  INT NOT NULL,
  sell_qty        INT NOT NULL,
  sell_prices     JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (report_date, kind, row_key)
);

-- A row's history across days.
CREATE INDEX wechat_market_rows_key_idx ON wechat_market_rows (kind, row_key, report_date);

-- Each group memtrade read that day, so a quiet day can be told apart from a
-- group the Mac never received.
CREATE TABLE wechat_market_groups (
  report_date     DATE NOT NULL REFERENCES wechat_market_days(report_date) ON DELETE CASCADE,
  group_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  messages        INT NOT NULL,
  candidates      INT NOT NULL,
  -- First message memtrade has from the group; a recent one means newly joined.
  first_seen      TIMESTAMPTZ,
  PRIMARY KEY (report_date, group_id)
);

-- The evidence: one row per quoted item per post. A post is one sender saying
-- one thing; every copy of it across groups and hours is one of its
-- `messages`. `row_keys` names the report lines it counted toward
-- ('quote:三星 64G 5600 DM0'), which is how a line finds its posts.
CREATE TABLE wechat_market_points (
  report_date     DATE NOT NULL REFERENCES wechat_market_days(report_date) ON DELETE CASCADE,
  post_key        TEXT NOT NULL,
  item_index      INT NOT NULL,
  sender_id       TEXT NOT NULL,
  sender_name     TEXT NOT NULL,
  group_ids       TEXT[] NOT NULL,
  first_at        TIMESTAMPTZ NOT NULL,
  last_at         TIMESTAMPTZ NOT NULL,
  messages        INT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('llm', 'rules')),
  direction       TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  brands          TEXT[] NOT NULL DEFAULT '{}',
  capacity_gb     INT,
  speed           INT,
  ddr             TEXT,
  rank            TEXT,
  form_factor     TEXT CHECK (form_factor IN ('server', 'pc')),
  part_codes      TEXT[] NOT NULL DEFAULT '{}',
  date_code       TEXT,
  condition       TEXT,
  price           NUMERIC(14,2),
  -- Masked or open-ended: "17XXX", "3XXX起".
  price_approx    BOOLEAN NOT NULL DEFAULT FALSE,
  currency        TEXT CHECK (currency IN ('RMB', 'USD')),
  tax             TEXT,
  qty             INT,
  location        TEXT,
  raw_line        TEXT NOT NULL,
  -- Looked up within one day only (a few thousand rows), so the primary key's
  -- report_date prefix is the index.
  row_keys        TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (report_date, post_key, item_index)
);
