-- When memtrade last asked the ERP for work (kind 'rerun_poll': every
-- /push/reruns/claim, whatever the answer). The WeChat page uses it to tell a
-- re-run memtrade is about to take from one waiting on a poller that has
-- stopped, as when the office Mac's scheduled job broke.

CREATE TABLE wechat_market_heartbeats (
  kind     TEXT PRIMARY KEY,
  seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
