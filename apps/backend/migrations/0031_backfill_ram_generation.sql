-- One-time data repair for order_lines written before scan-time normalization
-- existed (commit c491160 / src/ai/normalize.ts). Symptom: a manager opening an
-- order (e.g. SO-1369) sees RAM lines whose DDR generation is blank and whose
-- capacity / part number are non-canonical, because an earlier mobile-submit
-- flow dropped the separate `generation` field and stored raw OCR text.
--
-- The original AI extraction is still in label_scans.extracted, so generation
-- is recoverable. This mirrors normalizeFields() applied retroactively.
--
-- The migration runner has NO applied-migrations table — every file re-runs on
-- every boot — so every statement below is guarded to touch only still-damaged
-- rows and is a no-op once the data is clean.

-- 1. Recover blank RAM generation from the original scan: prefer the explicit
--    `generation` key, fall back to a DDR/PC-looking `type` key.
UPDATE order_lines ol
SET generation = g.gen
FROM (
  SELECT ol2.id,
         'DDR' || (regexp_match(
           COALESCE(NULLIF(ls.extracted->>'generation',''), ls.extracted->>'type'),
           '(?:DDR\s*|PC)([2-5])', 'i'))[1] AS gen
  FROM order_lines ol2
  JOIN label_scans ls ON ls.cf_image_id = ol2.scan_image_id
  WHERE ol2.category = 'RAM'
    AND (ol2.generation IS NULL OR ol2.generation = '')
    AND COALESCE(NULLIF(ls.extracted->>'generation',''), ls.extracted->>'type')
        ~* '(?:DDR\s*|PC)[2-5]'
) g
WHERE ol.id = g.id AND g.gen IS NOT NULL;

-- 2. Canonicalise capacity: drop internal spaces, uppercase the unit,
--    default a bare number to GB ("32 GB" -> "32GB", "1.92 tb" -> "1.92TB").
UPDATE order_lines
SET capacity =
      (regexp_match(replace(upper(capacity), ' ', ''), '^([0-9.]+)'))[1]
   || CASE
        WHEN replace(upper(capacity), ' ', '') ~ '(TB|T)$' THEN 'TB'
        ELSE 'GB'
      END
WHERE capacity IS NOT NULL
  AND capacity ~ '^\s*[0-9.]+\s*(GB|TB|G|T)?\s*$'
  AND capacity <> (regexp_match(replace(upper(capacity), ' ', ''), '^([0-9.]+)'))[1]
                || CASE WHEN replace(upper(capacity), ' ', '') ~ '(TB|T)$'
                        THEN 'TB' ELSE 'GB' END;

-- 3. Strip "PN:" / "P/N" / "S/N" / "Part No:" prefixes from part numbers.
UPDATE order_lines
SET part_number =
      regexp_replace(part_number,
        '^\s*(?:P\s*/?\s*N|S\s*/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*', '', 'i')
WHERE part_number ~* '^\s*(?:P\s*/?\s*N|S\s*/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*\S';
