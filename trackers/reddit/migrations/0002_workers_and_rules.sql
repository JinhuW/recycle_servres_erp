-- Fleet visibility + prompt-based alert rules.

-- One row per running process. Purely observational: nothing schedules off
-- this table, so a stale row can mislead an operator but never break the
-- fleet. Staleness is computed at read time; there is no reaper.
CREATE TABLE IF NOT EXISTS workers (
  worker_id         TEXT PRIMARY KEY,
  role              TEXT NOT NULL CHECK (role IN ('worker', 'api')),
  started_at        TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Per-loop {lastSuccessAt, lastWorkAt} snapshot, written whole on each beat.
  loops             JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Named buying rules. Enabled rules are appended to the eval_prompt setting at
-- evaluation time — still one LLM call per post. Rules live in the database
-- (not env) so an API edit reaches the whole fleet within a settings TTL.
CREATE TABLE IF NOT EXISTS rules (
  id         INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
