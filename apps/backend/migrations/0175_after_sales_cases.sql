-- After-sales: a customer comes back about goods on a sold order, and the case
-- runs until the goods are returned or a discount is agreed. The workflow and
-- its transition table live in routes/afterSales.ts.
INSERT INTO id_counters (name, value) VALUES ('AS', 1000)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE after_sales_cases (
  id             TEXT PRIMARY KEY,
  sell_order_id  TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'Open'
                   CHECK (status IN ('Open', 'In progress', 'Awaiting return', 'Resolved', 'Cancelled')),
  resolution     TEXT CHECK (resolution IN ('return', 'discount')),
  issue          TEXT NOT NULL,
  -- Refund (return) or price reduction (discount), in USD like sell_order_lines.unit_price.
  amount         NUMERIC(12,2) CHECK (amount >= 0),
  assignee_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at      TIMESTAMPTZ
);
CREATE INDEX after_sales_cases_sell_order_id_idx ON after_sales_cases(sell_order_id);
CREATE INDEX after_sales_cases_assignee_id_idx ON after_sales_cases(assignee_id);
CREATE INDEX after_sales_cases_created_by_idx ON after_sales_cases(created_by);
CREATE INDEX after_sales_cases_status_created_idx ON after_sales_cases(status, created_at DESC);

-- A snapshot of the lines the case is about: a sell-order save rewrites its
-- lines with new ids, so the link is kept only while that row lives.
CREATE TABLE after_sales_case_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  sell_order_line_id  UUID REFERENCES sell_order_lines(id) ON DELETE SET NULL,
  label               TEXT NOT NULL,
  part_number         TEXT,
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  unit_price          NUMERIC(12,2) NOT NULL
);
CREATE INDEX after_sales_case_lines_case_id_idx ON after_sales_case_lines(case_id);
CREATE INDEX after_sales_case_lines_sell_order_line_id_idx ON after_sales_case_lines(sell_order_line_id);

CREATE TABLE after_sales_case_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      TEXT NOT NULL REFERENCES after_sales_cases(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('created', 'status', 'edited', 'note')),
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX after_sales_case_events_case_idx ON after_sales_case_events(case_id, created_at);
CREATE INDEX after_sales_case_events_actor_id_idx ON after_sales_case_events(actor_id);
