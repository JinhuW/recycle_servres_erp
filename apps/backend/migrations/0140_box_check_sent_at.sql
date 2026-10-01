-- Send flags to purchaser used to re-send every current flag on each click.
-- Each flag and extra now records when it went out; Send only sends what has
-- not, and editing a flag's reason or note clears its stamp so the new
-- version goes out again.
ALTER TABLE order_line_checks ADD COLUMN flag_sent_at TIMESTAMPTZ;
ALTER TABLE order_check_extras ADD COLUMN sent_at TIMESTAMPTZ;

-- 0139's comments predate the full-count default: an untouched line reads as
-- its whole qty on the client, and the tick is its own answer.
COMMENT ON COLUMN order_line_checks.counted IS
  'Units found. The client treats a line with no row as fully counted; the column default is unused.';
COMMENT ON COLUMN order_line_checks.checked_at IS
  'When the manager ticked the line. Not derived from counted; orders the Checked group.';
