-- PayPal cases opened on a payment, so the Payments page can say that money it
-- is reconciling is being claimed back.
--
-- A column rather than a table of its own, for two reasons that are both bugs
-- avoided rather than taste.  One transaction can carry more than one case (a
-- PayPal claim and a card chargeback, or a closed inquiry followed by a new
-- claim), and a LEFT JOIN that multiplies rows breaks the LIMIT n+1 keyset
-- paging the feed is built on.  And the Mercury settlement leg carries the same
-- paypal_txn_id — parsed out of its description — so a join would badge both
-- legs of an unpaired pair and count one case twice.  Writing the column on the
-- PayPal row alone makes neither problem exist.
--
-- Shape: an array of case objects, newest first.  See NormalizedDispute in
-- banktx/paypal.ts; message threads, evidence and counterparty PII are stripped
-- before anything is stored here.
ALTER TABLE bank_transactions
  ADD COLUMN dispute JSONB;

-- The feed's own ordering, narrowed to the disputed rows: the filter is a lens
-- over the same keyset scan, not a separate query shape.
CREATE INDEX bank_transactions_dispute_idx
  ON bank_transactions (posted_at DESC, id) WHERE dispute IS NOT NULL;

-- Disputes sit behind a *separate* PayPal app permission from Transaction
-- Search, so they can fail while transactions keep arriving.  That failure has
-- to be visible on the page — a silently empty dispute list reads as good news.
ALTER TABLE bank_accounts
  ADD COLUMN dispute_error TEXT;
