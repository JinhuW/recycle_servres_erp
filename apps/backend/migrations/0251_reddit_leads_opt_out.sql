-- A seller who asked not to be contacted stays that way. `closed = 'optout'`
-- is the holder's view; `opted_out_at` is the seller's, and survives release
-- and re-import, so the next purchaser can't claim and message them again.

ALTER TABLE reddit_leads ADD COLUMN opted_out_at TIMESTAMPTZ;

ALTER TABLE reddit_leads DROP CONSTRAINT reddit_leads_closed_check;
ALTER TABLE reddit_leads ADD CONSTRAINT reddit_leads_closed_check
  CHECK (closed IN ('','nostock','lost','optout'));

-- 'opt_in' is a manager lifting the stamp.
ALTER TABLE reddit_lead_events DROP CONSTRAINT reddit_lead_events_kind_check;
ALTER TABLE reddit_lead_events ADD CONSTRAINT reddit_lead_events_kind_check
  CHECK (kind IN ('imported','claimed','released','dm','reply',
                  'stage','follow_up','closed','reopened','opt_in'));

-- First DMs per purchaser per day are counted from the ledger.
CREATE INDEX reddit_lead_events_actor_kind_idx ON reddit_lead_events(actor_id, kind, created_at);
