-- Cross-post dedup and the PM tracer.

-- A copy of a listing buyers were already alerted to (src/dedup.ts). It was
-- judged like any post, so its verdict still scores its prompt version; it just
-- never reaches Telegram.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;
ALTER TABLE posts ADD CONSTRAINT posts_status_check
  CHECK (status IN ('new', 'rejected', 'target', 'notified', 'failed', 'duplicate'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS duplicate_of TEXT REFERENCES posts (reddit_id);

-- What the tracer (src/loops/trace.ts) counted once the post was a day old:
-- every comment, and the distinct commenters asking to buy by PM or chat.
-- comments_checked_at with NULL counts means the post was gone or unreadable.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS comments_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comment_count       INT,
  ADD COLUMN IF NOT EXISTS pm_count            INT;

CREATE INDEX IF NOT EXISTS idx_posts_author
  ON posts (lower(author), posted_at) WHERE author IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_pending_trace
  ON posts (posted_at DESC) WHERE comments_checked_at IS NULL;

-- A job exactly one process in the fleet runs at a time. The holder renews
-- its row; once expires_at passes, any eligible worker may take it over.
CREATE TABLE IF NOT EXISTS loop_leases (
  name       TEXT PRIMARY KEY,
  worker_id  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
