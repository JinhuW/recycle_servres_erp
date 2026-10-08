-- A manager's sign-off on a sell order. Done needs one from every active
-- manager. A row approves the order as it stood when signed: `fingerprint` is
-- services/sellOrderSignoff.ts's hash of the customer, currency and lines, and
-- a row whose hash no longer matches the order no longer counts. So nothing
-- that edits an order has to remember to clear these.
CREATE TABLE sell_order_signoffs (
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sell_order_id, user_id)
);
CREATE INDEX sell_order_signoffs_user_id_idx ON sell_order_signoffs(user_id);
