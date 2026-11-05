-- 0224: an account's browser profile, and the record of its pilot enrollment.
--
-- fleet_slots.device is deleted with the slot, so removing and re-adding an
-- account forgot its seed and let it be seeded again: a second new machine to
-- Facebook. The profile now lives on the pool row, which outlives every slot.
-- A NULL browser_engine is an account with no profile of its own: a stock slot
-- whose clock still follows its proxy, as it always has.
--
-- Two accounts on one seed are one machine to Facebook, so the seed is unique
-- across every pool row, retired ones included: a retired account's fingerprint
-- has been seen, and a new account showing it would be linked to the old one.

ALTER TABLE fb_pool_accounts
  ADD COLUMN browser_engine   TEXT CHECK (browser_engine IN ('stock', 'cloak')),
  ADD COLUMN cloak_seed       INTEGER,
  ADD COLUMN cloak_gpu        TEXT,
  ADD COLUMN profile_timezone TEXT,
  ADD CONSTRAINT fb_pool_accounts_cloak_has_seed CHECK (browser_engine <> 'cloak' OR cloak_seed IS NOT NULL);

-- Slots the engine switch already seeded. DISTINCT ON because the seed comes
-- from a hash of the account number and nothing has held it unique until now:
-- a second holder must not stop the backend booting, and its slot still carries
-- its own device.
UPDATE fb_pool_accounts a SET
  browser_engine = CASE WHEN s.device->>'browser_engine' = 'cloak' THEN 'cloak' ELSE 'stock' END,
  cloak_seed = (s.device->>'cloak_seed')::int,
  cloak_gpu = s.device->>'cloak_gpu',
  profile_timezone = s.device->>'timezone'
FROM (
  SELECT DISTINCT ON (device->>'cloak_seed') account_no, device
  FROM fleet_slots
  WHERE device->>'cloak_seed' ~ '^[0-9]{1,9}$'
  ORDER BY device->>'cloak_seed', account_no
) s
WHERE a.no = s.account_no;

CREATE UNIQUE INDEX fb_pool_accounts_cloak_seed_key ON fb_pool_accounts (cloak_seed) WHERE cloak_seed IS NOT NULL;

-- One row per account ever enrolled, written with its slot in one transaction.
-- It is the pilot's denominator, and an account that does badly can't leave it:
-- neither retiring (which deletes the slot) nor removing the pool row touches
-- it, so there is deliberately no foreign key, as with fb_pool_events. uid and
-- batch are copied for the same reason.
--
-- pilot_id is NULL for an account given an engine outside any pilot. exit_ip is
-- the exit measured at enrollment and is never rewritten: a later change is what
-- a cohort has to be able to see. An enrollment is active while its account has
-- a slot.
CREATE TABLE fleet_pilot_enrollments (
  account_no       INTEGER PRIMARY KEY,
  uid              TEXT NOT NULL,
  batch            TEXT NOT NULL,
  pilot_id         TEXT,
  arm              TEXT NOT NULL CHECK (arm IN ('cloak', 'stock')),
  seed             INTEGER,
  exit_ip          TEXT NOT NULL,
  enrolled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_claimed_at TIMESTAMPTZ,
  enrolled_by      TEXT,
  CONSTRAINT fleet_pilot_enrollments_seed_matches_arm CHECK ((arm = 'cloak') = (seed IS NOT NULL))
);
CREATE INDEX fleet_pilot_enrollments_exit_ip_idx ON fleet_pilot_enrollments (exit_ip);
CREATE INDEX fleet_pilot_enrollments_pilot_idx ON fleet_pilot_enrollments (pilot_id, arm);
