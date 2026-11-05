-- The cohort scorecard looks up an account's stints once per exit change. With
-- no index on the account it scans the table each time, and a port that flaps
-- for weeks can take the read to the 60 s statement timeout.
CREATE INDEX fb_worker_accounts_account_idx ON fb_worker_accounts (account_no, started_at);
