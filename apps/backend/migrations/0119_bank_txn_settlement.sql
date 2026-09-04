-- Whether the money actually moved.  Both providers used to drop everything
-- that had not settled, so a payment in flight was indistinguishable from a
-- payment that never happened — a $20,570 PayPal charge sat pending for
-- fifteen days without existing anywhere in the ERP.
--
-- One normalised vocabulary over two provider spellings (PayPal S/P/D/V,
-- Mercury sent/pending/cancelled/failed/reversed/blocked): the mapping belongs
-- in TypeScript beside each provider's other field mapping, as `category` does
-- since 0101, not in SQL where six WHERE clauses would each have to repeat it.
--
-- DEFAULT 'settled' is a correct backfill rather than a guess: every row
-- already stored passed the old 'S'/'sent' filter.
ALTER TABLE bank_transactions
  ADD COLUMN settle_status TEXT NOT NULL DEFAULT 'settled'
    CHECK (settle_status IN ('settled', 'pending', 'failed', 'reversed'));

-- The feed's own ordering, narrowed to the rows that have not settled — the
-- filter is a lens over the same keyset scan, not a separate query shape.
CREATE INDEX bank_transactions_settle_idx
  ON bank_transactions (posted_at DESC, id) WHERE settle_status <> 'settled';

-- A one-shot rewind so the transactions that are *already* pending arrive.
-- syncOne asks each provider for everything since `cursor - 5 days`, and every
-- pending row in production was last touched before that window; without this
-- the feature ships and the payment that prompted it still is not there.  180
-- days rather than clearing the cursor, because a NULL cursor falls to the
-- 90-day BACKFILL_MS default and the oldest pending row is older than that.
--
-- Idempotent: the sync upserts on (source, external_id) and stamps a fresh
-- cursor when the run finishes, so this costs one long fetch, once.
UPDATE bank_accounts
  SET sync_cursor = NOW() - INTERVAL '180 days';
