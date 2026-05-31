-- The inventory export joins one representative scan per line via a LATERAL
-- lookup on label_scans.cf_image_id (= order_lines.scan_image_id), ordered by
-- created_at. Unindexed, that was a sequential scan of label_scans per export
-- row. 0035 indexed the order_lines side only; this indexes the label_scans
-- side so the LATERAL becomes an index seek. Idempotent — migrate.mjs /
-- resetDb may replay this.
CREATE INDEX IF NOT EXISTS label_scans_cf_image_idx
  ON label_scans(cf_image_id, created_at);
