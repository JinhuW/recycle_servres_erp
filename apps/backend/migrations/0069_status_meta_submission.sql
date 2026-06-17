-- Widen status-meta to a second key, 'Submission' — optional attachments a
-- purchaser leaves when submitting a PO. Attachments-only: the note reuses the
-- order-level notes field, so no order_status_meta row is required. The inline
-- CHECK from 0068 is auto-named <table>_status_check.

ALTER TABLE order_status_meta
  DROP CONSTRAINT order_status_meta_status_check,
  ADD  CONSTRAINT order_status_meta_status_check CHECK (status IN ('Submission', 'Done'));

ALTER TABLE order_status_attachments
  DROP CONSTRAINT order_status_attachments_status_check,
  ADD  CONSTRAINT order_status_attachments_status_check CHECK (status IN ('Submission', 'Done'));
