-- Allow spreadsheet attachments (vendor lot manifests / price lists) on the PO
-- Submission dropzone. getUploadLimits INTERSECTS this stored list with
-- SAFE_UPLOAD_MIME, so widening the constant alone changes nothing on a
-- database that already ran 0025 — the stored list has to move too.
--
-- Union rather than replace: a workspace that deliberately narrowed the list
-- keeps whatever else it set. Idempotent.
UPDATE workspace_settings SET value = (
  SELECT jsonb_agg(DISTINCT m)
  FROM jsonb_array_elements_text(
    value || '["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","text/csv"]'::jsonb
  ) AS m
)
WHERE key = 'upload_allowed_mime';
