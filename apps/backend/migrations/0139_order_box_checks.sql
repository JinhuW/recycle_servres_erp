-- Box check: a manager counts a PO's lines against the box that arrived.
-- One row per line that has been touched; a line with no row is uncounted.
-- The order is reached through order_lines.order_id, so there is no second
-- copy of it here to drift out of step.
--
-- A short count is recorded as a flag, never as a qty change: the line keeps
-- what the purchaser bought until someone edits it on the PO page.
CREATE TABLE order_line_checks (
  line_id     UUID PRIMARY KEY REFERENCES order_lines(id) ON DELETE CASCADE,
  counted     INTEGER NOT NULL DEFAULT 0 CHECK (counted >= 0),
  flag_reason TEXT CHECK (flag_reason IN ('missing','short','wrong_part','damaged','not_as_described')),
  flag_note   TEXT,
  -- Set when counted reaches the line's qty; orders the Checked group.
  checked_at  TIMESTAMPTZ,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_line_checks_updated_by_idx ON order_line_checks(updated_by);

-- Something in the box that no line names — a scan that matched nothing.
CREATE TABLE order_check_extras (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  note        TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_check_extras_order_idx ON order_check_extras(order_id);
CREATE INDEX order_check_extras_created_by_idx ON order_check_extras(created_by);
