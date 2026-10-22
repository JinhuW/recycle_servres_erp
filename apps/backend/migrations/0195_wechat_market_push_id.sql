-- Each push of a day gets an id, which its point batches may name: a batch
-- left over from a push the day has since replaced is refused instead of
-- landing in the new one. And the day keeps its stored point count, which the
-- day list read with one COUNT over the points per day on every visit.
ALTER TABLE wechat_market_days
  ADD COLUMN push_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN stored_points INT  NOT NULL DEFAULT 0;

UPDATE wechat_market_days d
   SET stored_points = (SELECT COUNT(*) FROM wechat_market_points p WHERE p.report_date = d.report_date);
