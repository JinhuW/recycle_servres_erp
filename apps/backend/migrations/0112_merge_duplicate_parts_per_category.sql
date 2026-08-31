-- Finishes the merge 0110 started. 0110 grouped by canonical part number
-- alone, then refused to touch any group whose rows disagreed on category —
-- so a single foreign-category row poisoned the whole group and the genuine
-- duplicates inside it stayed split. With RAM "A-1", RAM "A_1" and SSD "A1",
-- the two RAM spellings each kept their own ref_prices row and their own price
-- for one product, which is the exact thing 0110 set out to end.
--
-- Grouping by (canon, category) merges those and still leaves the
-- cross-category rows alone, which remains deliberate: two rows that collide
-- on the key but sit in different categories are two products, not one typed
-- twice. routes/market.ts already expects several rows per canon and answers a
-- lookup with the freshest reading.
--
-- 0110 is applied on dev and could not be corrected in place — an edited
-- migration never re-runs, so dev would have silently diverged from prod. This
-- supersedes it instead, and is a no-op against anything 0110 already merged
-- (those groups are down to one row, which the HAVING excludes).
--
-- The canon below is inlined in full — prefix strip AND the widened separator
-- class — so this grouping cannot disagree with runtime for a value stored
-- with a "PN:" label. A .sql file can't import the TS constant; what keeps
-- them together is the assertion in tests/market-batch-lookup.test.ts.
--
-- Idempotent: it leaves no (canon, category) group with more than one row.

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
SELECT canon, category, count(*) AS rows
FROM _pn_canon
WHERE canon <> ''
GROUP BY canon, category
HAVING count(*) > 1;

-- A part number is a single token (packages/shared/src/partNumberSynth.ts), so
-- the spelling without whitespace is the one to keep. Then: the spelling more
-- lines already carry, the more recently touched row, and finally the
-- alphabetical one so the choice is the same on every database. The usage
-- count is confined to the category being merged — a spelling's popularity
-- under some other category has no bearing on which row wins here.
CREATE TEMP TABLE _pn_winner ON COMMIT DROP AS
SELECT DISTINCT ON (c.canon, c.category)
       c.canon, c.category, c.id AS win_id, c.part_number AS win_pn
FROM _pn_canon c
JOIN _pn_groups g ON g.canon = c.canon AND g.category = c.category
LEFT JOIN LATERAL (
  SELECT count(*) AS uses
  FROM (
    SELECT part_number, category FROM order_lines
    UNION ALL SELECT part_number, category FROM sell_order_lines
    UNION ALL SELECT part_number, category FROM vendor_bid_lines
  ) l
  WHERE l.part_number = c.part_number AND l.category = c.category
) u ON TRUE
ORDER BY c.canon, c.category,
         (c.part_number ~ '[[:space:]]'),
         u.uses DESC,
         c.updated_at DESC,
         c.part_number;

CREATE TEMP TABLE _pn_loser ON COMMIT DROP AS
SELECT c.id AS loser_id, c.part_number AS loser_pn, c.category,
       w.win_id, w.win_pn
FROM _pn_canon c
JOIN _pn_winner w ON w.canon = c.canon AND w.category = c.category
WHERE c.id <> w.win_id;

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

-- Re-spell the lines that carry a merged-away spelling. Matched on category as
-- well as spelling: a loser is only a loser within its own category, and the
-- same spelling can be a loser in two categories with two different winners —
-- without the category the join re-spells a foreign category's lines, and
-- picks between the two winners arbitrarily.
UPDATE order_lines o SET part_number = l.win_pn
FROM _pn_loser l
WHERE o.part_number = l.loser_pn AND o.category = l.category
  AND l.loser_pn <> l.win_pn;

UPDATE sell_order_lines s SET part_number = l.win_pn
FROM _pn_loser l
WHERE s.part_number = l.loser_pn AND s.category = l.category
  AND l.loser_pn <> l.win_pn;

UPDATE vendor_bid_lines v SET part_number = l.win_pn
FROM _pn_loser l
WHERE v.part_number = l.loser_pn AND v.category = l.category
  AND l.loser_pn <> l.win_pn;
