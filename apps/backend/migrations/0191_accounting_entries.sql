-- Accounting: the managers' own book of money received and paid, kept in RMB.
-- Payments reconciles the company's USD bank accounts; this is the money that
-- moves through the managers' hands — a supplier paid by Alipay, a purchaser's
-- commission by WeChat, a customer's bank transfer. Entries are a record only:
-- nothing here changes a PO's cost, a sell order's revenue or a case's amount.
INSERT INTO id_counters (name, value) VALUES ('AC', 1000)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE accounting_entries (
  id              TEXT PRIMARY KEY,
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind            TEXT NOT NULL CHECK (kind IN ('purchase', 'commission', 'sale', 'after_sales', 'other')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'USD')),
  -- CNY per 1 USD when a dollar entry was booked: it turns the dollars into
  -- the book's RMB and stays put when the FX ledger moves on. An RMB entry
  -- needs no rate, so it never waits on the rate service.
  fx_rate         NUMERIC(18,8) CHECK (fx_rate > 0 AND fx_rate <= 100),
  amount_cny      NUMERIC(14,2) GENERATED ALWAYS AS (
                    CASE WHEN currency = 'CNY' THEN amount ELSE ROUND(amount * fx_rate, 2) END
                  ) STORED,
  method          TEXT NOT NULL CHECK (method IN ('bank', 'alipay', 'wechat', 'cash', 'other')),
  -- A calendar date as the manager gave it, not an instant: the book is kept
  -- on their side of the world.
  occurred_on     DATE NOT NULL,
  -- Whose money moved. Members are deactivated, never deleted.
  manager_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- SET NULL like bank_transactions: a deleted draft PO leaves the money it
  -- was paid on the book, without its link.
  order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
  sell_order_id   TEXT REFERENCES sell_orders(id) ON DELETE SET NULL,
  after_sales_id  TEXT REFERENCES after_sales_cases(id) ON DELETE SET NULL,
  counterparty    TEXT,
  reference       TEXT,
  note            TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at       TIMESTAMPTZ,
  voided_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason     TEXT,
  -- Which link a kind may carry. The route requires the link on a write;
  -- these only refuse the wrong one, so a SET NULL never trips them.
  CONSTRAINT accounting_entries_order_kind
    CHECK (order_id IS NULL OR kind IN ('purchase', 'commission')),
  CONSTRAINT accounting_entries_sell_order_kind
    CHECK (sell_order_id IS NULL OR kind = 'sale'),
  CONSTRAINT accounting_entries_after_sales_kind
    CHECK (after_sales_id IS NULL OR kind = 'after_sales'),
  CONSTRAINT accounting_entries_void_reason
    CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT accounting_entries_rate_for_dollars
    CHECK ((currency = 'USD') = (fx_rate IS NOT NULL))
);
CREATE INDEX accounting_entries_book_idx ON accounting_entries (occurred_on DESC, created_at DESC, id DESC);
-- Serves the FK and the running balance, which is kept per manager.
CREATE INDEX accounting_entries_manager_book_idx ON accounting_entries (manager_id, occurred_on, created_at, id);
CREATE INDEX accounting_entries_order_id_idx ON accounting_entries (order_id);
CREATE INDEX accounting_entries_sell_order_id_idx ON accounting_entries (sell_order_id);
CREATE INDEX accounting_entries_after_sales_id_idx ON accounting_entries (after_sales_id);
CREATE INDEX accounting_entries_created_by_idx ON accounting_entries (created_by);
CREATE INDEX accounting_entries_voided_by_idx ON accounting_entries (voided_by);

CREATE TABLE accounting_entry_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    TEXT NOT NULL REFERENCES accounting_entries(id) ON DELETE CASCADE,
  -- 'unlinked': the record it was for was deleted (a draft PO), see
  -- routes/orders/lifecycle.ts.
  kind        TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'voided', 'restored', 'unlinked')),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX accounting_entry_events_entry_idx ON accounting_entry_events (entry_id, created_at);
CREATE INDEX accounting_entry_events_actor_id_idx ON accounting_entry_events (actor_id);
