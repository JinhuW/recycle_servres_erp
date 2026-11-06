-- 0229: what an account's browser really was the first time it launched.
--
-- cloak_seed says what the account was given, not what it showed: distinct seeds
-- can come out with the same canvas and WebGL. So the worker reports the launch
-- before any Facebook page, and this is the record every later launch is held to.
--
-- profile_device keeps the screen with the account, since fleet_slots.device goes
-- with the slot and a re-add would otherwise work it out again from whatever the
-- screen list says by then. Stock accounts in no pilot have none, as before.
--
-- profile_fingerprint is deliberately not unique: an account already shown to
-- Facebook can't take a new seed, so a clash there has to be recorded and raised,
-- not refused.

ALTER TABLE fb_pool_accounts
  ADD COLUMN profile_device            JSONB,
  ADD COLUMN profile_first_launched_at TIMESTAMPTZ,
  ADD COLUMN profile_fingerprint       TEXT,
  ADD COLUMN profile_launch            JSONB,
  ADD COLUMN profile_launch_changed    JSONB;

CREATE INDEX fb_pool_accounts_profile_fingerprint_idx ON fb_pool_accounts (profile_fingerprint) WHERE profile_fingerprint IS NOT NULL;

UPDATE fb_pool_accounts a SET profile_device = (
    SELECT jsonb_object_agg(f.key, f.value) FROM jsonb_each(s.device) f
    WHERE f.key IN ('viewport', 'screen', 'device_scale_factor', 'locale', 'native')
  )
FROM fleet_slots s
WHERE s.account_no = a.no AND a.browser_engine IS NOT NULL AND jsonb_typeof(s.device) = 'object';

-- #76 and #130 ran on CloakBrowser before 0224, whose backfill read only live
-- slots, and both had been retired, so their seeds were never kept and a new
-- account could draw one. Both date from when a seed was fleetCloakFor(no) alone.
UPDATE fb_pool_accounts a SET browser_engine = 'cloak', cloak_seed = v.seed, cloak_gpu = v.gpu
FROM (VALUES (76, 46429, 'Intel'), (130, 76860, 'Intel')) AS v(no, seed, gpu)
WHERE a.no = v.no AND a.cloak_seed IS NULL
  AND EXISTS (SELECT 1 FROM fleet_worker_state_events e WHERE e.account_no = a.no AND e.engine = 'cloak')
  AND NOT EXISTS (SELECT 1 FROM fb_pool_accounts o WHERE o.cloak_seed = v.seed);

-- DEGRADED and DEAD can both come before the first Facebook page; the rest can't.
UPDATE fb_pool_accounts a SET profile_first_launched_at = (
    SELECT MIN(e.at) FROM fleet_worker_state_events e
    WHERE e.account_no = a.no AND e.engine = 'cloak' AND e.to_state NOT IN ('DEGRADED', 'DEAD')
  )
WHERE a.cloak_seed IS NOT NULL;

-- 0224 let a second holder of a seed keep it on its slot; nothing holds one now,
-- and every path to a slot's seed goes through the pool row's unique index.
CREATE UNIQUE INDEX fleet_slots_cloak_seed_key ON fleet_slots ((device->>'cloak_seed')) WHERE device->>'cloak_seed' IS NOT NULL;
