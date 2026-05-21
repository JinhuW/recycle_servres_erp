-- Brute-force throttle for POST /api/auth/login. Append-only audit of login
-- attempts; the route counts recent FAILED attempts per email (since that
-- email's last success) and locks further attempts once the threshold is hit.
-- Idempotent: migrate.mjs re-runs every file on each boot.
CREATE TABLE IF NOT EXISTS login_attempts (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  ip            TEXT,
  success       BOOLEAN NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_time_idx
  ON login_attempts (email, attempted_at DESC);
