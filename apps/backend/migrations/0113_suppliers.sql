-- Clients: the people we BUY from. The buy-side counterparty had no table at
-- all — `customers` is the sell side (sell_orders.customer_id) and vendor_links
-- are bidders who buy FROM us. Who a purchase order was bought from survived
-- only as free text on shipments.from_name, packages.seller_name, and a
-- ' · '-joined blob in orders.notes, which is why banktx/match.ts has to fuzzy
-- string match to reconcile a payment.
--
-- Named `suppliers` in the schema and "Clients" in the UI: 客户 is already taken
-- by customers, so the two would collide in Chinese.
--
-- Standing (prospect/active/archived) is stored because a human decides it.
-- Health (on track / gone quiet / lost touch) and tier are NOT stored — they
-- are derived per read from order history, the same discipline orders.category
-- and orders.total_cost follow. A stored status is a status that goes stale.

CREATE TABLE suppliers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  company           TEXT,
  phone             TEXT,
  email             TEXT,
  street1           TEXT,
  street2           TEXT,
  city              TEXT,
  state             TEXT,
  zip               TEXT,
  country           TEXT NOT NULL DEFAULT 'US',
  -- The purchaser accountable for the relationship. NULL = house account,
  -- which is where a departing purchaser's book lands rather than nowhere.
  owner_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual','shipping','package','referral',
                                        'facebook','reddit','walk_in')),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('prospect','active','archived')),
  -- What they say they can get. The other half — what they actually sold us —
  -- is derived from order_lines and never typed.
  supplies          TEXT[] NOT NULL DEFAULT '{}',
  -- The five things a purchaser re-asks on every deal if nobody wrote them down.
  pref_payment      TEXT,
  pref_logistics    TEXT,
  pref_contact      TEXT,
  pref_best_time    TEXT,
  pref_price        TEXT,
  notes             TEXT,
  -- NULL = use the tier default from settings. Set only when a client asks to
  -- be contacted on their own schedule.
  cadence_days      INT CHECK (cadence_days IS NULL OR cadence_days BETWEEN 1 AND 365),
  -- A manager pinning a tier the spend formula would not produce (e.g. the only
  -- reliable source of something we are short of).
  tier_override     CHAR(1) CHECK (tier_override IS NULL OR tier_override IN ('A','B','C')),
  next_follow_up_at DATE,
  last_contacted_at TIMESTAMPTZ,
  -- Dedup handle, GENERATED so it can never drift from name/zip. The alphanumeric
  -- compression matches what banktx/match.ts already uses on seller names.
  --
  -- Generated rather than computed in TypeScript on purpose: partNumberCanon.ts
  -- documents what the other way costs — a JS canon and its SQL twin disagreed
  -- on whitespace (JS \s matches U+00A0, POSIX [[:space:]] does not), so a value
  -- went out under one key and came back under another. Never re-implement this
  -- in application code.
  match_key         TEXT GENERATED ALWAYS AS (
                      regexp_replace(upper(name), '[^A-Z0-9]', '', 'g')
                      || '|' || COALESCE(zip, '')
                    ) STORED,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NULLS NOT DISTINCT (PG15+) so two house accounts with the same match_key
-- collide too; without it NULL owner_id would let unlimited duplicates through.
CREATE UNIQUE INDEX suppliers_owner_match_idx
  ON suppliers (owner_id, match_key) NULLS NOT DISTINCT;
CREATE INDEX suppliers_owner_idx ON suppliers (owner_id);
CREATE INDEX suppliers_match_key_idx ON suppliers (match_key);
CREATE INDEX suppliers_follow_up_idx ON suppliers (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL AND status <> 'archived';

-- The contact log. Deliberately NOT trigger-locked append-only like
-- order_events: a typo'd note has to be deletable by whoever wrote it. This is
-- institutional memory, not a compliance ledger. `owner_changed` rows are
-- written by the reassign endpoint so a book handover shows up on the same
-- timeline as the calls.
CREATE TABLE supplier_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('note','call','text','visit','offer','owner_changed')),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX supplier_notes_supplier_idx ON supplier_notes (supplier_id, created_at DESC);
CREATE INDEX supplier_notes_author_idx   ON supplier_notes (author_id);

-- "Not interested" on a suggested seller has to stick, or the same one-off
-- Craigslist seller reappears every week and the rail becomes noise.
CREATE TABLE supplier_suggestion_dismissals (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_key  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, match_key)
);

-- SET NULL, not CASCADE: deleting a client must never delete purchase orders.
ALTER TABLE orders ADD COLUMN supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
CREATE INDEX orders_supplier_id_idx ON orders (supplier_id);
