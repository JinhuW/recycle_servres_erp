-- Per-account sync health. sync_error holds the part of the last run that
-- failed without failing the source (Mercury's card list, one card's
-- transactions); a clean run clears it. deep_synced_at is when the account was
-- last fetched far enough back to see a settled row reversed late — the
-- normal cursor window only reaches a few days behind.
ALTER TABLE bank_accounts
  ADD COLUMN sync_error TEXT,
  ADD COLUMN deep_synced_at TIMESTAMPTZ;
