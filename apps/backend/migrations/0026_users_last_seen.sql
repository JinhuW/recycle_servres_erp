-- Track when a member last signed in so the Members admin can show real
-- "Last active" text (was a deterministic client-side mock) and so members
-- who have never signed in can be surfaced as pending invites. Stamped on
-- successful login. Idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
