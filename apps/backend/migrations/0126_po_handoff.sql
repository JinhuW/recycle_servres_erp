-- The Draft → In Transit hand-off asks how the goods reach the warehouse and
-- how the seller was paid, and records the answers on the order.
--
-- source mirrors packages.source (0106) — same values, same CHECK — so a
-- package created from the hand-off copies it verbatim, and a PO minted from
-- a delivered package inherits it. Nullable: orders that predate the hand-off
-- have no answer.
--
-- payment_method is nullable on purpose and never backfilled. NULL means "not
-- asked yet" and keeps the historical rule (a company-paid PO needs its PayPal
-- transaction id); the hand-off writes 'paypal' or 'cash' for company card and
-- leaves self-paid orders NULL — a self-paid order has no method, it is
-- reimbursed from commission. No cross-column CHECK: PATCH may flip `payment`
-- without touching the method, and a constraint there would turn that into a
-- 500.
ALTER TABLE orders
  ADD COLUMN source TEXT CHECK (source IN ('facebook','local','reddit','other')),
  ADD COLUMN handoff_method TEXT CHECK (handoff_method IN ('pickup','label')),
  ADD COLUMN handoff_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN payment_method TEXT CHECK (payment_method IN ('paypal','cash'));

CREATE INDEX orders_handoff_by_idx ON orders(handoff_by);

-- A self-paid PO leaves Draft only once the chat with the seller is attached
-- (a Submission attachment). Stamped NOW() like po_company_txn_required_from
-- (0115), so every environment grandfathers the drafts it already holds.
INSERT INTO workspace_settings (key, value)
VALUES ('po_self_pay_chat_required_from', to_jsonb(NOW()))
ON CONFLICT (key) DO NOTHING;
