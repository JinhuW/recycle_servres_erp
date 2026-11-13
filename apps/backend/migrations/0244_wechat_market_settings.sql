-- Settings for memtrade's daily WeChat report, edited by managers on
-- Monitors ▸ WeChat ▸ Settings and fetched by memtrade with its wechat:write
-- token before it writes the day.
--
-- summary_prompt          the market-note prompt; no row = memtrade's own.
-- summary_prompt_default  memtrade's built-in prompt, as it last reported it,
--                         so the page can show and restore it.

CREATE TABLE wechat_market_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX wechat_market_settings_updated_by ON wechat_market_settings (updated_by);
