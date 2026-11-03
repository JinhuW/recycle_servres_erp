-- 0221: every change of an ERP-fleet worker's reported state, so account
-- losses (SESSION_EXPIRED, CHECKPOINT, CHALLENGE_*) can be counted per browser
-- engine. fleet_workers.state keeps only the latest value.
--
-- A row is written in the heartbeat transaction that changed the state, and
-- only then. `engine` is the slot's fleet_slots.device->>'browser_engine' at
-- that moment, 'stock' when the device names none. A claim's reset of the
-- state to NULL is not a row: a boot is not something the account did.
--
-- account_no carries no foreign key, as in fb_worker_accounts: the history has
-- to outlive a pool account that is deleted.

CREATE TABLE fleet_worker_state_events (
  id         BIGSERIAL PRIMARY KEY,
  account_no INTEGER,
  worker_id  TEXT NOT NULL,
  engine     TEXT NOT NULL DEFAULT 'stock',
  from_state TEXT,
  to_state   TEXT NOT NULL,
  reason     TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fleet_worker_state_events_account_idx ON fleet_worker_state_events(account_no, at);
CREATE INDEX fleet_worker_state_events_at_idx ON fleet_worker_state_events(at);
