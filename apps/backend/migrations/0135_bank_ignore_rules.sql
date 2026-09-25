-- Manager-taught ignores. Recurring card spend (gas, meals, labels, rent)
-- lands in the unlinked queue every sync and has to be dismissed by hand; a
-- rule names it once and every sync dismisses it from then on. Same shape as
-- the counterparty transfer rules (0102), with the rule id kept on the row so
-- retracting the rule can give its rows back.
CREATE TABLE bank_ignore_rules (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source     TEXT CHECK (source IN ('mercury', 'paypal')),   -- NULL = either
  pattern    TEXT NOT NULL CHECK (length(btrim(pattern)) > 0),
  label      TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bank_ignore_rules_created_by_idx ON bank_ignore_rules (created_by);

-- ignore_rule_id set: the rule ignored it (revertable). NULL and ignored: a
-- human did. no_auto_ignore is the tombstone a human's Unignore leaves on a
-- rule-ignored row, like no_auto_pair / no_auto_link.
ALTER TABLE bank_transactions
  ADD COLUMN ignore_rule_id UUID REFERENCES bank_ignore_rules(id) ON DELETE SET NULL,
  ADD COLUMN no_auto_ignore BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX bank_transactions_ignore_rule_id_idx
  ON bank_transactions (ignore_rule_id) WHERE ignore_rule_id IS NOT NULL;
