-- A login now reserves its attempt row before checking the password, so a
-- burst of concurrent guesses all count against each other instead of every
-- one passing the throttle before any of them is recorded. NULL success is
-- that reservation, settled to TRUE/FALSE once bcrypt answers (and deleted if
-- the request is refused or fails first). The counts treat NULL as a failure.
ALTER TABLE login_attempts ALTER COLUMN success DROP NOT NULL;

-- The per-address budget counts by the limiter key (an IPv4 address, or the
-- /64 an IPv6 one sits in); `ip` keeps the full address for the record.
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS ip_key TEXT;
CREATE INDEX IF NOT EXISTS login_attempts_ip_key_time_idx
  ON login_attempts (ip_key, attempted_at DESC);
