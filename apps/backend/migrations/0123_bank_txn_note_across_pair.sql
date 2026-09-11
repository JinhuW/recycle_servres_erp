-- 0120 promised a note lives on every leg of a paired payment, but only the
-- manual /pair endpoint copied it across; the sync's auto-pairing set pair_id
-- and nothing else, and the feed papered over that by reading the note off
-- whichever leg had one. The sync now copies the note when it pairs; this
-- catches the pairs it made before it did.

UPDATE bank_transactions t
SET note = s.note, note_by = s.note_by, note_at = s.note_at
FROM bank_transactions s
WHERE t.pair_id = s.pair_id
  AND t.id <> s.id
  AND t.note IS NULL
  AND s.note IS NOT NULL;
