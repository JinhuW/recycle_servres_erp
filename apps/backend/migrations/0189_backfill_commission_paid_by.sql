-- From here on the manager who uploads the commission screenshot is taken to
-- have paid it, which 0162 refused to guess. Orders that already carry a
-- screenshot but have nobody on file get the uploader of their latest one, as
-- the upload would now record them, with the Activity line it writes (marked
-- as a backfill). A pick by hand, the company, and an uploader who is not a
-- manager are left alone.
WITH latest AS (
  SELECT DISTINCT ON (a.order_id) a.order_id, a.uploaded_by
  FROM order_status_attachments a
  WHERE a.status = 'Commission' AND a.uploaded_by IS NOT NULL
  ORDER BY a.order_id, a.uploaded_at DESC, a.id DESC
), filled AS (
  UPDATE orders o
     SET commission_paid_by = l.uploaded_by
    FROM latest l
    JOIN users u ON u.id = l.uploaded_by AND u.role = 'manager'
   WHERE o.id = l.order_id
     AND o.commission_paid_by IS NULL
     AND NOT o.commission_paid_by_company
  RETURNING o.id, l.uploaded_by, u.name
)
INSERT INTO order_events (order_id, actor_id, kind, detail)
SELECT f.id, f.uploaded_by, 'meta_changed',
       jsonb_build_object('backfilled', true, 'changes', jsonb_build_array(
         jsonb_build_object('field', 'commission_paid_by', 'from', NULL, 'to', f.name)))
FROM filled f;
