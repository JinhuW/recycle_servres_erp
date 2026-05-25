-- The 'Closed' sell-order status (mig 0053) captures evidence the same
-- way Shipped / Awaiting payment / Done do: a note + optional attachments
-- via the per-status meta tables. Widen both CHECKs so the close handler
-- can upsert into sell_order_status_meta and so the attachments routes
-- accept 'Closed' as a valid per-status bucket.
--
-- We intentionally do NOT add 'Draft' here. Reopen notes (Closed → Draft)
-- live in sell_order_events instead; status_meta is keyed by
-- (sell_order_id, status), so successive reopens would overwrite each
-- other and we'd lose history. Events preserve the full reopen audit.

ALTER TABLE sell_order_status_meta
  DROP CONSTRAINT IF EXISTS sell_order_status_meta_status_check;
ALTER TABLE sell_order_status_meta
  ADD CONSTRAINT sell_order_status_meta_status_check
  CHECK (status IN ('Shipped','Awaiting payment','Done','Closed'));

ALTER TABLE sell_order_status_attachments
  DROP CONSTRAINT IF EXISTS sell_order_status_attachments_status_check;
ALTER TABLE sell_order_status_attachments
  ADD CONSTRAINT sell_order_status_attachments_status_check
  CHECK (status IN ('Shipped','Awaiting payment','Done','Closed'));
