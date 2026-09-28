-- Submissions from the public website forms: the ram4cash.com sell form (a
-- lot of RAM/SSD/CPU lines with label photos) and the recycleservers.com
-- quote form. Both land here first and are triaged on the manager-only
-- "Web submissions" page; a sell lot only becomes a Draft PO when a manager
-- converts it, so an anonymous POST never writes to the orders table.
--
-- The form keeps its own shape in `payload` (the validated, cleaned body):
-- the two forms share almost nothing beyond who is asking, and the page
-- renders each kind from its payload. Who-is-asking is pulled into columns so
-- the list can search and show it without reaching into JSON.

-- A converted lot files its seller as a house-account supplier. None of the
-- existing sources describes "typed their own details into our website":
-- referral implies a person referred them, manual implies a purchaser keyed
-- them in. orders.source is left alone on purpose (it mirrors packages.source);
-- a web lot maps to 'other' there.
ALTER TABLE suppliers
  DROP CONSTRAINT IF EXISTS suppliers_source_check;

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_source_check
  CHECK (source IN ('manual','shipping','package','referral','facebook','reddit','walk_in','web'));

-- WS-1001 is the reference the site shows the sender, so it follows the
-- PO/SO/TO/VB human-id scheme (0029) rather than exposing a uuid.
INSERT INTO id_counters (name, value) VALUES ('WS', 1000)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE web_submissions (
  id          TEXT PRIMARY KEY,
  site        TEXT NOT NULL CHECK (site IN ('ram4cash','recycleservers')),
  kind        TEXT NOT NULL CHECK (kind IN ('sell_lot','quote')),
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','contacted','converted','archived','spam')),
  name        TEXT,
  company     TEXT,
  email       TEXT NOT NULL,
  phone       TEXT,
  notes       TEXT,
  -- The form's ?src= channel (web / facebook / reddit) for a sell lot.
  source      TEXT,
  payload     JSONB NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  order_id    TEXT REFERENCES orders(id) ON DELETE SET NULL,
  staff_note  TEXT,
  handled_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX web_submissions_created_idx ON web_submissions (created_at DESC, id DESC);
CREATE INDEX web_submissions_status_idx ON web_submissions (status);
CREATE INDEX web_submissions_order_idx ON web_submissions (order_id);
CREATE INDEX web_submissions_handled_by_idx ON web_submissions (handled_by);

-- Label photos of a sell lot, by the payload line they belong to. Converting
-- the lot COPIES each object for order_line_photos rather than sharing the
-- key, so deleting a photo off the PO never breaks the submission.
CREATE TABLE web_submission_photos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  TEXT NOT NULL REFERENCES web_submissions(id) ON DELETE CASCADE,
  line_index     INTEGER NOT NULL,
  filename       TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  mime_type      TEXT NOT NULL,
  storage_key    TEXT NOT NULL,
  delivery_url   TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX web_submission_photos_submission_idx
  ON web_submission_photos (submission_id, line_index, position);
