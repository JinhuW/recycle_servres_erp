-- first_claimed_at marks a claim, and a claim can end before any browser opens.
-- first_login_at marks the first Facebook page, which is what the first-login
-- hold and the re-record path are about.
--
-- exit_timezone is the zone measured with exit_ip, so a move that keeps the IP
-- and changes the geo can be told from a profile that was pinned elsewhere.
ALTER TABLE fleet_pilot_enrollments
  ADD COLUMN first_login_at TIMESTAMPTZ,
  ADD COLUMN exit_timezone TEXT;

-- Pilot accounts a move landed on the same exit as. They aren't on the port, so
-- slots can't name them, and a cohort still has to flag them.
ALTER TABLE fleet_proxy_exit_changes
  ADD COLUMN shares_with INTEGER[] NOT NULL DEFAULT '{}';

-- A URL edit detaches the port's checks, so the next round has nothing to
-- compare with. This keeps the last good reading until that round records the move.
ALTER TABLE fleet_proxies ADD COLUMN replaced_exit JSONB;
