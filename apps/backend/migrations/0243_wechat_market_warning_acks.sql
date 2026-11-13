-- A manager acknowledges one of a report day's warnings (Monitors ▸ WeChat),
-- such as a gap in the group history the Mac can't fill after the fact, so
-- the banner stops asking for attention.
--
-- Keyed by the warning's text, not a row of wechat_market_days: a re-run
-- deletes and re-inserts the day, and should keep the acknowledgement of a
-- warning it repeats word for word while a new or changed one shows again.

CREATE TABLE wechat_market_warning_acks (
  report_date  DATE NOT NULL,
  warning      TEXT NOT NULL,
  acked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  acked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (report_date, warning)
);

CREATE INDEX wechat_market_warning_acks_acked_by ON wechat_market_warning_acks (acked_by);
