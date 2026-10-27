-- A manager asks for a report day to be redone (Monitors ▸ WeChat ▸ Re-run).
-- The ERP can't reach memtrade on the office Mac, so the request waits here:
-- memtrade polls with its wechat:write token, claims it, reruns the day,
-- pushes it as usual and says how it went.
--
-- No foreign key to wechat_market_days: the rerun's own push deletes and
-- re-inserts the day, which would cascade the request away mid-run.

CREATE TABLE wechat_market_reruns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date   DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  -- Done, but Claude was still unavailable and memtrade fell back to its rules.
  degraded      BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT
);

-- One open request per day: a second click joins the first.
CREATE UNIQUE INDEX wechat_market_reruns_open ON wechat_market_reruns (report_date)
  WHERE status IN ('queued', 'running');
CREATE INDEX wechat_market_reruns_day ON wechat_market_reruns (report_date, requested_at DESC);
CREATE INDEX wechat_market_reruns_requested_by ON wechat_market_reruns (requested_by);
