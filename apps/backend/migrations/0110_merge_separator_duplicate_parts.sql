-- Merge catalogue rows that are the same part spelled with different
-- separators: i5 10500t / i5-10500t, HMCG78AGBSA095N BA / HMCG78AGBSA095N-BA,
-- Mixed 256gb sata / MIXED_256GB_SATA. Each spelling opened its own ref_prices
-- row and recorded its own price for one product, because the canonical key
-- dropped whitespace but kept `-` and `_` until this release widened it
-- (src/lib/part-number.ts, index rebuilt in 0111).
--
-- The canon below is inlined in full — prefix strip AND the widened separator
-- class — so this grouping cannot disagree with runtime for a value stored with
-- a "PN:" label. A .sql file can't import the TS constant; what keeps them
-- together is the pg_get_indexdef assertion in tests/market-batch-lookup.test.ts.
--
-- Idempotent: it leaves no group with more than one row, so a re-run is a no-op.

CREATE TEMP TABLE _pn_canon ON COMMIT DROP AS
SELECT id, part_number, category, updated_at,
       UPPER(
         REGEXP_REPLACE(
           REGEXP_REPLACE(
             part_number,
             '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)([[:space:]]*[:#][[:space:]]*|[[:space:]]+)',
             '',
             'i'
           ),
           '[[:space:]_-]+',
           '',
           'g'
         )
       ) AS canon
FROM ref_prices
WHERE COALESCE(part_number, '') <> '';

CREATE TEMP TABLE _pn_groups ON COMMIT DROP AS
SELECT canon, count(*) AS rows, count(DISTINCT category) AS categories
FROM _pn_canon
WHERE canon <> ''
GROUP BY canon
HAVING count(*) > 1;

-- Two rows that collide on the key but sit in different categories are two
-- products, not one typed two ways. Leave them and say so.
DO $$
DECLARE g RECORD;
BEGIN
  FOR g IN SELECT canon FROM _pn_groups WHERE categories > 1 LOOP
    RAISE NOTICE 'part-number merge: skipping % — its rows disagree on category', g.canon;
  END LOOP;
END $$;

-- A part number is a single token (packages/shared/src/partNumberSynth.ts), so
-- the spelling without whitespace is the one to keep. Then: the spelling more
-- lines already carry, the more recently touched row, and finally the
-- alphabetical one so the choice is the same on every database.
CREATE TEMP TABLE _pn_winner ON COMMIT DROP AS
SELECT DISTINCT ON (c.canon)
       c.canon, c.id AS win_id, c.part_number AS win_pn
FROM _pn_canon c
JOIN _pn_groups g ON g.canon = c.canon AND g.categories = 1
LEFT JOIN LATERAL (
  SELECT count(*) AS uses
  FROM (
    SELECT part_number FROM order_lines
    UNION ALL SELECT part_number FROM sell_order_lines
    UNION ALL SELECT part_number FROM vendor_bid_lines
  ) l
  WHERE l.part_number = c.part_number
) u ON TRUE
ORDER BY c.canon,
         (c.part_number ~ '[[:space:]]'),
         u.uses DESC,
         c.updated_at DESC,
         c.part_number;

CREATE TEMP TABLE _pn_loser ON COMMIT DROP AS
SELECT c.id AS loser_id, c.part_number AS loser_pn, w.win_id, w.win_pn
FROM _pn_canon c
JOIN _pn_winner w ON w.canon = c.canon AND c.id <> w.win_id;

-- Price history first: ref_price_events cascades on delete, so a loser dropped
-- before its events are repointed takes them with it and nothing raises.
UPDATE ref_price_events e
SET ref_price_id = l.win_id
FROM _pn_loser l
WHERE e.ref_price_id = l.loser_id;

UPDATE ref_prices w SET
  history = w.history || COALESCE((
    SELECT jsonb_agg(h.elem)
    FROM _pn_loser l
    JOIN ref_prices r ON r.id = l.loser_id
    CROSS JOIN LATERAL jsonb_array_elements(r.history) h(elem)
    WHERE l.win_id = w.id
  ), '[]'::jsonb),
  samples = GREATEST(w.samples, COALESCE((
    SELECT MAX(r.samples) FROM _pn_loser l JOIN ref_prices r ON r.id = l.loser_id
    WHERE l.win_id = w.id
  ), 0)),
  -- Stats stay the winner's; a loser only fills a column the winner never had,
  -- so a price picked up on the other spelling since this was scoped survives.
  target = COALESCE(w.target, (
    SELECT r.target FROM _pn_loser l JOIN ref_prices r ON r.id = l.loser_id
    WHERE l.win_id = w.id AND r.target IS NOT NULL ORDER BY r.updated_at DESC LIMIT 1)),
  low_price = COALESCE(w.low_price, (
    SELECT r.low_price FROM _pn_loser l JOIN ref_prices r ON r.id = l.loser_id
    WHERE l.win_id = w.id AND r.low_price IS NOT NULL ORDER BY r.updated_at DESC LIMIT 1)),
  high_price = COALESCE(w.high_price, (
    SELECT r.high_price FROM _pn_loser l JOIN ref_prices r ON r.id = l.loser_id
    WHERE l.win_id = w.id AND r.high_price IS NOT NULL ORDER BY r.updated_at DESC LIMIT 1)),
  avg_sell = COALESCE(w.avg_sell, (
    SELECT r.avg_sell FROM _pn_loser l JOIN ref_prices r ON r.id = l.loser_id
    WHERE l.win_id = w.id AND r.avg_sell IS NOT NULL ORDER BY r.updated_at DESC LIMIT 1))
WHERE w.id IN (SELECT win_id FROM _pn_loser);

-- last_price is a reading, not a total: the group's most recent one wins, and
-- its three columns have to come from that same row.
UPDATE ref_prices w SET
  last_price        = b.last_price,
  last_price_at     = b.last_price_at,
  last_price_source = b.last_price_source
FROM (
  SELECT DISTINCT ON (x.win_id)
         x.win_id, r.last_price, r.last_price_at, r.last_price_source
  FROM (
    SELECT win_id, loser_id AS id FROM _pn_loser
    UNION ALL
    SELECT win_id, win_id FROM _pn_loser
  ) x
  JOIN ref_prices r ON r.id = x.id
  WHERE r.last_price_at IS NOT NULL
  ORDER BY x.win_id, r.last_price_at DESC
) b
WHERE w.id = b.win_id;

DELETE FROM ref_prices r USING _pn_loser l WHERE r.id = l.loser_id;

-- Re-spell the lines that carry a merged-away spelling. Exact match, so this
-- touches only the rows this merge is about.
UPDATE order_lines o SET part_number = l.win_pn
FROM _pn_loser l WHERE o.part_number = l.loser_pn AND l.loser_pn <> l.win_pn;

UPDATE sell_order_lines s SET part_number = l.win_pn
FROM _pn_loser l WHERE s.part_number = l.loser_pn AND l.loser_pn <> l.win_pn;

UPDATE vendor_bid_lines v SET part_number = l.win_pn
FROM _pn_loser l WHERE v.part_number = l.loser_pn AND l.loser_pn <> l.win_pn;
