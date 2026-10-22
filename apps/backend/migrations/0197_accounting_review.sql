-- Accounting review: one manager who didn't write an entry signs it off.
--
-- The author is whoever wrote the version on the book: the recorder, then
-- whoever last changed a field the review covers (every field but the note).
-- The 0196 backfill was recorded by nobody, so those entries have no author
-- and any manager reviews them.
--
-- An entry's review state is derived, never stored as a word:
--   voided                      → out of review
--   reviewed_at                 → Reviewed
--   query_at and no answer_at   → Queried
--   review_cleared_at           → Changed since review (an edit cleared one)
--   otherwise                   → To review
ALTER TABLE accounting_entries
  ADD COLUMN author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at       TIMESTAMPTZ,
  ADD COLUMN review_cleared_at TIMESTAMPTZ,
  -- A reviewer's question to the author (or, with no author, the entry's
  -- manager), and the answer. The pair stays on the entry until the next
  -- review, so whoever reviews it then reads both.
  ADD COLUMN query_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN query_text        TEXT,
  ADD COLUMN query_at          TIMESTAMPTZ,
  ADD COLUMN answer_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN answer_text       TEXT,
  ADD COLUMN answer_at         TIMESTAMPTZ,
  -- One-sided, so a reviewer's SET NULL never trips them.
  ADD CONSTRAINT accounting_entries_reviewed_at CHECK (reviewed_by IS NULL OR reviewed_at IS NOT NULL),
  ADD CONSTRAINT accounting_entries_query CHECK ((query_at IS NULL) = (query_text IS NULL)),
  ADD CONSTRAINT accounting_entries_answer CHECK (answer_at IS NULL OR query_at IS NOT NULL);

UPDATE accounting_entries SET author_id = created_by;

CREATE INDEX accounting_entries_author_id_idx ON accounting_entries (author_id);
CREATE INDEX accounting_entries_reviewed_by_idx ON accounting_entries (reviewed_by);
CREATE INDEX accounting_entries_query_by_idx ON accounting_entries (query_by);
CREATE INDEX accounting_entries_answer_by_idx ON accounting_entries (answer_by);
-- Review mode's queue: live entries nobody has signed off, oldest first.
CREATE INDEX accounting_entries_review_queue_idx
  ON accounting_entries (occurred_on, created_at, id)
  WHERE voided_at IS NULL AND reviewed_at IS NULL;

ALTER TABLE accounting_entry_events DROP CONSTRAINT accounting_entry_events_kind_check;
ALTER TABLE accounting_entry_events ADD CONSTRAINT accounting_entry_events_kind_check CHECK (kind IN (
  'created', 'edited', 'voided', 'restored', 'unlinked',
  'reviewed', 'unreviewed', 'queried', 'answered', 'query_withdrawn'
));

-- A sign-off is only worth its record. The other ledgers Activity shows are
-- append-only by trigger (0012, 0037, 0050; cascade-tolerant since 0038);
-- this one now joins them there, so it is held to the same rule.
CREATE FUNCTION accounting_entry_events_lock() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'accounting_entry_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER accounting_entry_events_no_update BEFORE UPDATE ON accounting_entry_events
  FOR EACH ROW EXECUTE FUNCTION accounting_entry_events_lock();
CREATE TRIGGER accounting_entry_events_no_delete BEFORE DELETE ON accounting_entry_events
  FOR EACH ROW EXECUTE FUNCTION accounting_entry_events_lock();

-- Activity's keyset walk over the newest events, as 0079 gives the others.
CREATE INDEX accounting_entry_events_feed_idx ON accounting_entry_events (created_at DESC, id DESC);
