-- RS-599: the WeChat market day's buy/sell breakdown, its most active traders
-- and the market's mood. memtrade computes all of it; every column is nullable
-- because a day pushed by a memtrade that predates it carries none of it.

ALTER TABLE wechat_market_days
  -- Units asked for / offered: each trader's largest figure per line, summed.
  ADD COLUMN buy_qty         INT,
  ADD COLUMN sell_qty        INT,
  -- Posts that stated a quantity, which the figures above rest on.
  ADD COLUMN buy_qty_posts   INT,
  ADD COLUMN sell_qty_posts  INT,
  -- Traders by the sides they posted: buyers = buy_only + both_sides.
  ADD COLUMN buy_only        INT,
  ADD COLUMN sell_only       INT,
  ADD COLUMN both_sides      INT,
  -- Not seen on that side in the 30 report days before.
  ADD COLUMN new_buyers      INT,
  ADD COLUMN new_sellers     INT,
  -- {buy: [...], sell: [...]}, ten each at most: senderId, name, posts, lines,
  -- qty, groups, both, mood.
  ADD COLUMN traders         JSONB,
  -- {score, bullish, neutral, bearish, urgent, buy: {...}, sell: {...}};
  -- score is (bullish − bearish) / voters × 100, one vote per trader.
  ADD COLUMN sentiment       JSONB;

-- {score, bullish, neutral, bearish} for the line.
ALTER TABLE wechat_market_rows ADD COLUMN sentiment JSONB;

ALTER TABLE wechat_market_points
  ADD COLUMN mood    TEXT CHECK (mood IN ('bullish', 'neutral', 'bearish')),
  ADD COLUMN urgent  BOOLEAN NOT NULL DEFAULT FALSE;
