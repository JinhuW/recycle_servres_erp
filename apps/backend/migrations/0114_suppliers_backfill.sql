-- One-time history import: turn every seller we have already shipped with or
-- tracked a package from into a client, and attach their purchase orders.
--
-- This is what makes the book useful on day one instead of empty. Order
-- matters: the shipment pass runs first (it carries a full address), so the
-- address-less package pass can attach to a real record instead of forking a
-- second one for the same person.
--
-- Grouping uses the COMPRESSED name — the same expression suppliers.match_key
-- is generated from — NOT the punctuation-sensitive key in
-- shipmentsGlobal.ts's /api/shipping/contacts. With the raw key,
-- "John's Servers" and "Johns Servers" form two groups that then collide on one
-- match_key, and ON CONFLICT DO NOTHING keeps whichever inserted first: the
-- surviving phone/address would only be the newest within one spelling.
--
-- owner_id is always the PO's owner, never whoever runs this migration. Seller
-- addresses on shipments are already scoped to the ordering purchaser
-- (shipments.ts guards reads with o.user_id), and flattening that into a shared
-- book would widen who can read them.

-- ── 1. Sellers with a real shipping address ────────────────────────────────
-- Contact details come from the newest complete row (an address changes, and
-- the latest one is the true one). The display NAME is picked separately: the
-- spelling used most often, newest as the tiebreak. Taking the name from the
-- newest row too would let one hasty "  johns   SERVERS " entry become what
-- every screen shows forever, and this name is on the row, the drawer and the
-- call list.
WITH base AS (
  SELECT
    o.user_id AS owner_id,
    regexp_replace(upper(s.from_name), '[^A-Z0-9]', '', 'g') AS ck,
    s.from_zip,
    regexp_replace(btrim(s.from_name), '[[:space:]]+', ' ', 'g') AS clean_name,
    s.from_phone, s.from_street1, s.from_street2,
    s.from_city, s.from_state, s.from_country, s.created_at
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  WHERE s.from_name    IS NOT NULL AND btrim(s.from_name) <> ''
    AND s.from_street1 IS NOT NULL
    AND s.from_city    IS NOT NULL
    AND s.from_state   IS NOT NULL
    AND s.from_zip     IS NOT NULL
), detail AS (
  SELECT DISTINCT ON (owner_id, ck, from_zip)
    owner_id, ck, from_zip, from_phone, from_street1, from_street2,
    from_city, from_state, from_country,
    MIN(created_at) OVER (PARTITION BY owner_id, ck, from_zip) AS first_seen
  FROM base
  ORDER BY owner_id, ck, from_zip, created_at DESC
), naming AS (
  SELECT DISTINCT ON (owner_id, ck, from_zip) owner_id, ck, from_zip, clean_name
  FROM (
    SELECT owner_id, ck, from_zip, clean_name,
           COUNT(*) OVER (PARTITION BY owner_id, ck, from_zip, clean_name) AS uses,
           MAX(created_at) OVER (PARTITION BY owner_id, ck, from_zip, clean_name) AS recent
    FROM base
  ) t
  ORDER BY owner_id, ck, from_zip, uses DESC, recent DESC
)
INSERT INTO suppliers
  (name, phone, street1, street2, city, state, zip, country,
   owner_id, source, status, created_at, updated_at)
SELECT n.clean_name, d.from_phone, d.from_street1, d.from_street2,
       d.from_city, d.from_state, d.from_zip, COALESCE(d.from_country, 'US'),
       d.owner_id, 'shipping', 'active', d.first_seen, d.first_seen
FROM detail d
JOIN naming n ON n.owner_id = d.owner_id AND n.ck = d.ck AND n.from_zip = d.from_zip
ON CONFLICT DO NOTHING;

-- ── 2. Name-only sellers from tracked packages ─────────────────────────────
-- Matched against existing clients on the compressed NAME ALONE (no zip), so a
-- package seller lands on the record the shipment pass just built rather than
-- forking an address-less twin.
WITH src AS (
  SELECT DISTINCT ON (o.user_id, regexp_replace(upper(p.seller_name), '[^A-Z0-9]', '', 'g'))
    o.user_id AS owner_id,
    regexp_replace(upper(p.seller_name), '[^A-Z0-9]', '', 'g') AS ck,
    regexp_replace(btrim(p.seller_name), '[[:space:]]+', ' ', 'g') AS clean_name,
    MIN(p.created_at) OVER (
      PARTITION BY o.user_id,
                   regexp_replace(upper(p.seller_name), '[^A-Z0-9]', '', 'g')) AS first_seen
  FROM packages p
  JOIN orders o ON o.id = p.order_id
  WHERE p.seller_name IS NOT NULL AND btrim(p.seller_name) <> ''
  ORDER BY o.user_id, ck, p.created_at DESC
)
INSERT INTO suppliers (name, owner_id, source, status, created_at, updated_at)
SELECT src.clean_name, src.owner_id, 'package', 'active', src.first_seen, src.first_seen
FROM src
WHERE NOT EXISTS (
  SELECT 1 FROM suppliers s2
  WHERE s2.owner_id IS NOT DISTINCT FROM src.owner_id
    AND regexp_replace(upper(s2.name), '[^A-Z0-9]', '', 'g') = src.ck
)
ON CONFLICT DO NOTHING;

-- ── 3. Attach purchase orders ──────────────────────────────────────────────
-- Shipment first (name + zip is the stronger match), then packages by name.
-- Both pick deterministically with ORDER BY … LIMIT 1: an order can carry more
-- than one shipment, and a compressed name can still match two records at
-- different postcodes.
UPDATE orders o SET supplier_id = (
  SELECT s.id FROM suppliers s
  WHERE s.owner_id IS NOT DISTINCT FROM o.user_id
    AND s.match_key = (
      SELECT regexp_replace(upper(sh.from_name), '[^A-Z0-9]', '', 'g') || '|' || sh.from_zip
      FROM shipments sh
      WHERE sh.order_id = o.id
        AND sh.from_name IS NOT NULL AND btrim(sh.from_name) <> ''
        AND sh.from_zip  IS NOT NULL
      ORDER BY sh.created_at
      LIMIT 1)
  ORDER BY s.created_at
  LIMIT 1)
WHERE o.supplier_id IS NULL
  AND EXISTS (
    SELECT 1 FROM shipments sh
    WHERE sh.order_id = o.id
      AND sh.from_name IS NOT NULL AND btrim(sh.from_name) <> ''
      AND sh.from_zip  IS NOT NULL);

UPDATE orders o SET supplier_id = (
  SELECT s.id FROM suppliers s
  WHERE s.owner_id IS NOT DISTINCT FROM o.user_id
    AND regexp_replace(upper(s.name), '[^A-Z0-9]', '', 'g') = (
      SELECT regexp_replace(upper(p.seller_name), '[^A-Z0-9]', '', 'g')
      FROM packages p
      WHERE p.order_id = o.id
        AND p.seller_name IS NOT NULL AND btrim(p.seller_name) <> ''
      ORDER BY p.created_at
      LIMIT 1)
  ORDER BY s.created_at
  LIMIT 1)
WHERE o.supplier_id IS NULL
  AND EXISTS (
    SELECT 1 FROM packages p
    WHERE p.order_id = o.id
      AND p.seller_name IS NOT NULL AND btrim(p.seller_name) <> '');

-- ── 4. Seed the follow-up schedule ─────────────────────────────────────────
-- Last contact is the last time they actually sold us something. Due dates are
-- spread across the next two weeks so day one is not sixty calls on a Monday.
UPDATE suppliers s SET
  last_contacted_at = agg.last_po,
  next_follow_up_at = CURRENT_DATE + (agg.rn % 14)
FROM (
  SELECT o.supplier_id,
         MAX(o.created_at) AS last_po,
         (row_number() OVER (PARTITION BY o.user_id ORDER BY MAX(o.created_at) DESC))::int AS rn
  FROM orders o
  WHERE o.supplier_id IS NOT NULL
  GROUP BY o.supplier_id, o.user_id
) agg
WHERE agg.supplier_id = s.id;
