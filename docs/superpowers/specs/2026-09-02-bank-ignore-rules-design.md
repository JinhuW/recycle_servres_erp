# Bank ignore rules — design

**Ticket:** RS-014 · **Date:** 2026-09-02 · **Status:** approved, not built

## The problem

The Payments queue exists to be drained.  Every unlinked row is money that
nobody has yet tied to a purchase order, and the tile count is meant to reach
zero.  A class of Mercury rows will never tie to one — card autopay, the
monthly service fee, wire fees, the bank's own charges — and they arrive again
every month.  `POST /:id/ignore` dismisses one row and remembers nothing, so
the same counterparty is dismissed by hand forever, and a queue that is never
empty stops being read.

## The shape this takes

The repo has already solved this once.  **Mark-as-transfer teaches a rule**: it
records the counterparty in `bank_transfer_counterparties` (migration `0102`),
reclassifies that counterparty's other rows immediately, and re-applies on
every sync.  An ignore rule is that mechanism pointed at `ignored` instead of
`category`.

Mirroring it deliberately buys three things: no new concept for the user, a
guard set already proven against this data, and a reviewer who can read the new
code against the old.

| | teaches | writes | table |
| --- | --- | --- | --- |
| `POST /:id/ignore` | nothing | `ignored` | — |
| `mark-transfer` | counterparty | `category` | `bank_transfer_counterparties` |
| **ignore rule** | up to 3 ANDed conditions | `ignored` | `bank_ignore_rules` |

## The risk that shapes everything below

**An ignore rule hides money.**  A pattern that is one word too broad silently
drops real seller payments out of the reconciliation queue — exactly the
failure the queue exists to prevent, and one that surfaces as an absence, which
nobody notices.

Four properties bound it, and each one is a line of the design rather than a
sentiment:

1. **A rule never touches a linked row** — `order_id IS NULL` in the matcher.
2. **A rule never overturns a human** — `ignored_manual`, the mirror of
   `category_manual`.
3. **Every hidden row names the rule that hid it** — `ignore_rule_id`, surfaced
   on the row's status chip.
4. **Deleting the rule undoes exactly what it did** — and nothing else.

## Data model

### Migration `0117_bank_ignore_rules.sql`

Three optional conditions, ANDed, as **nullable columns rather than JSON**.  A
closed set of three compiles straight into SQL with no expression parser and no
way to write a rule nobody can read back.

```sql
CREATE TABLE bank_ignore_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT NOT NULL CHECK (source IN ('mercury','paypal')),
  counterparty_eq   TEXT,        -- NULL = this condition is not part of the rule
  description_has  TEXT,        -- literal case-insensitive substring, no wildcards
  direction         TEXT CHECK (direction IN ('in','out')),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A rule with no text condition would match a whole account.
  CHECK (counterparty_eq IS NOT NULL OR description_has IS NOT NULL),
  UNIQUE (source, counterparty_eq, description_has, direction)
);

CREATE INDEX bank_ignore_rules_created_by_idx ON bank_ignore_rules (created_by);
```

`direction` alone cannot define a rule — the CHECK is what stops "ignore every
payment that leaves the account".

### Two columns on `bank_transactions`

```sql
ALTER TABLE bank_transactions
  ADD COLUMN ignored_manual BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN ignore_rule_id UUID REFERENCES bank_ignore_rules(id) ON DELETE SET NULL;

CREATE INDEX bank_transactions_ignore_rule_id_idx ON bank_transactions (ignore_rule_id);
```

Both are load-bearing:

- **`ignored_manual`** is the exact mirror of `category_manual`.  Any human
  verdict sets it — ignoring by hand *and* unignoring.  Without it, unignoring
  a rule-hidden row is silently undone by the next sync, and the user concludes
  the button is broken.
- **`ignore_rule_id`** makes "47 hidden" a cheap count, powers *View matches*,
  and makes deletion **exact**.  A row can match two rules; recomputing the
  match at delete time would un-hide rows a surviving rule still covers.
  The FK index is required by the repo's own convention (`0035`, `0040`).

Note that `0100`'s upsert already touches only provider-owned fields, so unlike
`category`, `ignored` survives a re-sync on its own.  The re-apply pass exists
to catch newly-arrived rows and rows whose counterparty or description changed,
not to repair what the upsert clobbered.

## Matcher — `apps/backend/src/banktx/ignoreRules.ts`

One exported function, `applyIgnoreRules(tx, source?)`: a single UPDATE joining
unresolved rows against the rules, stamping `ignored` and `ignore_rule_id`
together.

The description condition is a **literal substring test**, not `LIKE` — a
stored pattern containing `%` or `_` would otherwise silently widen the rule,
and escaping at write time would make the drawer display a pattern the user
never typed.  `strpos` sidesteps both: nothing to escape, and the stored text
is exactly what gets shown back.

```
FROM bank_ignore_rules r
WHERE bt.source = r.source
  AND (r.counterparty_eq  IS NULL OR bt.counterparty = r.counterparty_eq)
  AND (r.description_has IS NULL
       OR strpos(upper(bt.description), upper(r.description_has)) > 0)
  AND (r.direction IS NULL
       OR (r.direction = 'out' AND bt.amount < 0)
       OR (r.direction = 'in'  AND bt.amount > 0))
  AND bt.order_id IS NULL      -- never hide money tied to a PO
  AND NOT bt.ignored_manual    -- never overturn a human verdict
  AND NOT bt.ignored           -- don't re-stamp ownership of an already-hidden row
```

Then a second statement propagates the verdict across `pair_id`, because
hiding one leg of a paired payment and leaving the other reads as a broken
queue.  This is what the manual `POST /:id/ignore` already does via `groupOf`.

**Call sites — two, and only two:**

- `syncOne` (`banktx/sync.ts`), inside its existing transaction, **after
  `autoPair` and `autoLink`**.  Order is not incidental: running before
  `autoPair` would remove candidate legs from pairing (`autoPair` filters
  `NOT ignored`), and running before `autoLink` would hide a row that was
  about to be auto-linked to a PO.
- `POST /:id/ignore-rule`, scoped to the one new rule, when the user leaves
  "ignore those too" checked.

## API — `apps/backend/src/routes/bankTx.ts`

| endpoint | does |
| --- | --- |
| `POST /:id/ignore-rule` | Creates a rule taught by row `:id`. |
| `GET /:id/ignore-rule/preview` | Live match count for a candidate rule. |
| `GET /ignore-rules` | Rule list for the drawer. |
| `DELETE /ignore-rules/:ruleId` | Deletes a rule and reverses it. |
| `GET /?ruleId=…` | Existing list query, filtered to one rule's rows. |

**`POST /:id/ignore-rule`** takes **booleans only** —
`{counterparty, description, direction, applyExisting}`.  The server reads the
row and derives the values itself, exactly as `mark-transfer` derives its
counterparty.  The client cannot invent a pattern that no transaction taught,
which keeps the audit trail honest and removes a validation surface.  It 400s
when the row is linked (matching `mark-transfer`'s "unlink first" guard), and
when no condition is selected.  Returns `{ruleId, alsoIgnored}` so the UI can
toast "hid 47 transactions".

**`DELETE /ignore-rules/:ruleId`** runs one transaction: un-ignore
`WHERE ignore_rule_id = :ruleId AND NOT ignored_manual`, clearing
`ignore_rule_id`, then delete the rule.  Reversal must happen *before* the
delete — `ON DELETE SET NULL` would otherwise erase the evidence of what to
reverse.  Returns `{unignored}`.

`GET /stats` gains `ignoreRules: {count}` for the tile.

## Frontend — `apps/frontend/src/pages/desktop/DesktopPayments.tsx`

Desktop only.  Payments is already a manager-only page, so the feature inherits
its gating and needs no new role check.

- **The row's `Ignore` button gains a caret** — `[Ignore ▾]`.  The button
  itself still ignores just that row; the one-click path is untouched.  The
  caret opens the sheet, anchored to the button via the existing `actionsRef`
  pattern that `PoPicker` already uses.
- **`IgnoreRuleSheet`** (new component) — three checkboxes showing the values
  they would match, a debounced match count from the preview endpoint, and
  "Ignore those too" pre-checked.  Create is disabled until one condition is
  selected.
- **A `Rules` tile** joins Unlinked / Suggested / Linked / Refunds / Transfers
  / Ignored.  It is the one tile that **opens a drawer instead of filtering**,
  so `clickTile` and `tileActive` need an explicit carve-out — without it the
  tile would light up as an active filter it never sets.
- **`IgnoreRulesDrawer`** (new component) — one card per rule: the conditions
  in prose, hit count, author, date, `View matches`, `Delete`.
- **`payStatusIgnoredByRule`** on the chip of a rule-hidden row, so "why is
  this hidden" is answerable without opening the drawer.
- i18n EN + ZH for every new string, via `useT()`.

## Testing

Backend integration tests against real Postgres (`tests/bank-ignore-rules.test.ts`):

- values are derived server-side; a client-supplied pattern is ignored
- `applyExisting` true hides the backlog, false leaves it
- a sync hides newly-arrived matching rows
- **a hand-unignored row stays visible through the next sync** (`ignored_manual`)
- **a hand-ignored row is not attributed to a rule** and survives rule deletion
- delete reverses only that rule's non-manual rows
- a linked row is never hidden, and rule creation on one 400s
- both legs of a pair are hidden together
- a rule with no text condition is rejected by the CHECK

Frontend: the conditions→prose helper used by both the sheet and the drawer.

## Deliberately not built

- **Regex, OR, amount ranges.**  Three ANDed conditions cover the observed
  patterns.  An expression language is a far larger auditing surface for a
  feature whose failure mode is hiding money silently.
- **Editing a rule.**  Delete and re-teach.  Editing raises "what happens to
  the rows the old version hid" for no gain at this volume.
- **Cross-source rules.**  A counterparty name means different things at
  Mercury and PayPal.
- **Mobile and vendor shells.**  Payments is desktop-only.
