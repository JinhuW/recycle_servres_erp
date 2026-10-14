-- Shippo's tracking webhooks are not idempotent: a number registered twice
-- pushes two update streams for one box. The add-time call and the sweep
-- (and two backends through a rolling deploy) both read the NULL stamp and
-- could register the same number. A registrant now claims the row here
-- first; a claim a crash or a timed-out call left behind expires.
ALTER TABLE packages ADD COLUMN tracking_claimed_at TIMESTAMPTZ;
