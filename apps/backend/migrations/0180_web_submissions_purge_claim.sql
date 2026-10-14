-- The stale-submission purge selected its rows, deleted their photos and
-- then deleted the rows by id alone, with nothing between the three steps
-- stopping a manager from reopening or converting one of them: the
-- reopened submission went with its mail history, or kept photo URLs whose
-- objects were already gone. A purge now claims its rows first; triage and
-- conversion refuse a claimed row, and the final delete is conditional on
-- the claim and the state it was claimed in.
ALTER TABLE web_submissions ADD COLUMN purge_claimed_at TIMESTAMPTZ;
