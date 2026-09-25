// Manager-taught ignores (bank_ignore_rules). A rule is a case-insensitive
// "contains" on counterparty or description, optionally pinned to one source.
// Every sync and every rule edit runs the whole set: a row that two rules
// match must keep its ignore when one of them goes.

import type { Sql, TransactionSql } from 'postgres';
import { openRowFrag } from './match';

type Db = Sql | TransactionSql;

export type IgnoreRuleInput = { source: 'mercury' | 'paypal' | null; pattern: string };

// position() rather than ILIKE: a `%` or `_` typed into a pattern means the
// character, and escaping it in SQL that reads the pattern off a row is
// clumsier than not needing to.
export function ignoreRuleMatchFrag(sql: Db, legAlias: string, rule: IgnoreRuleInput | string) {
  const bt = sql(legAlias);
  const source = typeof rule === 'string' ? sql`${sql(rule)}.source` : sql`${rule.source}::text`;
  const pattern = typeof rule === 'string' ? sql`${sql(rule)}.pattern` : sql`${rule.pattern}::text`;
  return sql`
    (${source} IS NULL OR ${bt}.source = ${source})
    AND (position(lower(${pattern}) IN lower(COALESCE(${bt}.counterparty, ''))) > 0
      OR position(lower(${pattern}) IN lower(COALESCE(${bt}.description, ''))) > 0)`;
}

// Open rows only — the same set the Unlinked tile counts — minus rows a human
// gave back (no_auto_ignore) and rows whose pair sibling is linked (a group is
// one payment; ignoring half of it is the state /ignore refuses).
function eligibleFrag(sql: Db, legAlias: string) {
  const bt = sql(legAlias);
  return sql`
    ${openRowFrag(sql, legAlias)} AND NOT ${bt}.no_auto_ignore
    AND NOT EXISTS (
      SELECT 1 FROM bank_transactions sib
      WHERE ${bt}.pair_id IS NOT NULL AND sib.pair_id = ${bt}.pair_id AND sib.order_id IS NOT NULL)`;
}

// Applies every rule. Returns the number of rows ignored by this pass.
export async function applyIgnoreRules(tx: Db): Promise<number> {
  const hit = await tx`
    UPDATE bank_transactions bt
    SET ignored = TRUE, ignore_rule_id = r.id
    FROM bank_ignore_rules r
    WHERE ${ignoreRuleMatchFrag(tx, 'bt', 'r')} AND ${eligibleFrag(tx, 'bt')}`;
  // The other leg of a pair goes with it, under the same rule, even when the
  // rule matched only the display leg (a Mercury settlement reads "PAYPAL …").
  // Not limited to this pass's rows: autoPair lets a rule-ignored charge pair
  // with a settlement that arrives syncs later, and that leg is taken here.
  const spread = await tx`
    UPDATE bank_transactions bt
    SET ignored = TRUE, ignore_rule_id = s.ignore_rule_id
    FROM bank_transactions s
    WHERE s.ignore_rule_id IS NOT NULL AND s.ignored
      AND bt.pair_id = s.pair_id AND bt.id <> s.id
      AND NOT bt.ignored AND bt.order_id IS NULL`;
  return hit.count + spread.count;
}

// Gives a rule's rows back. The caller re-runs applyIgnoreRules afterwards so
// another rule that also matches them can claim them again.
export async function revertIgnoreRule(tx: Db, ruleId: string): Promise<number> {
  const r = await tx`
    UPDATE bank_transactions
    SET ignored = FALSE, ignore_rule_id = NULL
    WHERE ignore_rule_id = ${ruleId}`;
  return r.count;
}
