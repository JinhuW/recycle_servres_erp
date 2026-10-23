-- What has been going wrong on each worker, for the api's ops watch
-- (src/loops/watch.ts), which sends it to the ops Telegram group.

-- Per-loop {consecutiveFailures, lastError, lastErrorAt}, written whole on each
-- beat. Kept out of `loops`, whose shape is part of the ERP's /api/workers
-- contract.
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS loop_failures JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Every warn/error line any process logged, flushed with its heartbeat.
-- `sent_at` is set once the watch has delivered it; rows go after seven days.
CREATE TABLE IF NOT EXISTS worker_errors (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id TEXT NOT NULL,
  scope     TEXT NOT NULL,
  level     TEXT NOT NULL CHECK (level IN ('warn', 'error')),
  message   TEXT NOT NULL,
  fields    JSONB NOT NULL DEFAULT '{}'::jsonb,
  at        TIMESTAMPTZ NOT NULL,
  sent_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS worker_errors_unsent ON worker_errors (id) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS worker_errors_at ON worker_errors (at);

-- Alerts the watch has raised and not yet resolved, so a restarted api
-- neither pages again nor forgets to say an alert cleared.
CREATE TABLE IF NOT EXISTS watch_alerts (
  key       TEXT PRIMARY KEY,           -- down:<worker> or failing:<worker>:<loop>
  worker_id TEXT NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
