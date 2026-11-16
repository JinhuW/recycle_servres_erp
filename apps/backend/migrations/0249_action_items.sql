-- Actions: the shared kanban board of action items (routes/actions.ts). Any
-- employee creates a card and assigns it to any active employee; a card may
-- point at one ERP record.
INSERT INTO id_counters (name, value) VALUES ('TK', 1000)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE action_items (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'todo'
                       CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
  -- Order inside its column, top first; rewritten as 0..n-1 on every move.
  position           INTEGER NOT NULL DEFAULT 0,
  priority           TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  due_date           DATE,
  assignee_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  -- The one record the card is about. The FKs null out when the record is
  -- deleted (PO edits delete lots, web submissions are purged), so link_type
  -- and link_label are kept to say what it was. The label is a number, never a
  -- client's name: the board is shared and a client's name is its owner's.
  order_id           TEXT REFERENCES orders(id) ON DELETE SET NULL,
  sell_order_id      TEXT REFERENCES sell_orders(id) ON DELETE SET NULL,
  after_sales_id     TEXT REFERENCES after_sales_cases(id) ON DELETE SET NULL,
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  web_submission_id  TEXT REFERENCES web_submissions(id) ON DELETE SET NULL,
  order_line_id      UUID REFERENCES order_lines(id) ON DELETE SET NULL,
  link_type          TEXT CHECK (link_type IN ('po', 'so', 'as', 'client', 'ws', 'lot')),
  link_label         TEXT,
  -- Set on entering Done, cleared on leaving; the board drops a card 14 days on.
  completed_at       TIMESTAMPTZ,
  removed_at         TIMESTAMPTZ,
  removed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(order_id, sell_order_id, after_sales_id, supplier_id, web_submission_id, order_line_id) <= 1),
  CHECK ((link_type IS NULL) = (link_label IS NULL)),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX action_items_board_idx ON action_items (status, position) WHERE removed_at IS NULL;
CREATE INDEX action_items_assignee_id_idx ON action_items (assignee_id);
CREATE INDEX action_items_created_by_idx ON action_items (created_by);
CREATE INDEX action_items_removed_by_idx ON action_items (removed_by);
CREATE INDEX action_items_order_id_idx ON action_items (order_id);
CREATE INDEX action_items_sell_order_id_idx ON action_items (sell_order_id);
CREATE INDEX action_items_after_sales_id_idx ON action_items (after_sales_id);
CREATE INDEX action_items_supplier_id_idx ON action_items (supplier_id);
CREATE INDEX action_items_web_submission_id_idx ON action_items (web_submission_id);
CREATE INDEX action_items_order_line_id_idx ON action_items (order_line_id);
CREATE INDEX action_items_completed_idx ON action_items (completed_at DESC, id DESC)
  WHERE status = 'done' AND removed_at IS NULL;

CREATE TABLE action_item_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'moved', 'assigned', 'note', 'removed')),
  note        TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX action_item_events_item_idx ON action_item_events (item_id, created_at);
CREATE INDEX action_item_events_actor_id_idx ON action_item_events (actor_id);
