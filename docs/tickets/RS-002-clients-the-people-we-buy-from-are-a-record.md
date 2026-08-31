---
id: RS-002
title: "Clients: the people we buy from are a record"
type: story
status: done
priority: P2
created: 2026-08-31
reporter: jinhu
branch: session/20260828-175116
pr: "#224"
version: 1.108.0
related: [RS-001]
---

## Ask

**Not verbatim — the original words are gone.** This work was built on
2026-08-28/29, before [[RS-001]] created the ticket system, so there is no
record of how Jinhu phrased the request. Rather than invent a quotation, this
section reconstructs the ask from the branch's own commit messages and
`docs/superpowers/specs/2026-08-29-clients-mobile-design.md`:

> Track the people we buy from as first-class records, so we can see who our
> top suppliers are, who has gone quiet, and who owns each relationship — and
> make chasing them a two-tap job rather than a spreadsheet.

Every ticket from RS-003 onward carries the real words.

## Context

Purchase orders had **no counterparty at all**. Who we bought from survived
only as free text in three places — `shipments.from_name`,
`packages.seller_name`, and a joined blob in `orders.notes` — which is why
`banktx/match.ts` has to fuzzy-match strings to reconcile a payment against an
order. There was no way to ask who the top suppliers are, who has stopped
selling to us, or who owns a relationship.

The sell side already had `customers`. This is its mirror on the buy side, and
the naming had to dodge a collision: the UI calls them **Clients** and the
Chinese is 供货商, because 客户 is already taken by sell-side customers.

## Acceptance criteria

- [x] `suppliers` table with owner, structured preferences, contact log, and
      `orders.supplier_id` linking a PO to its counterparty.
- [x] Standing (prospect/active/archived) is stored; tier, health and the
      follow-up date are **derived per read** from order history.
- [x] Health is measured against each client's **own** rhythm — twice the
      median gap between their POs is "gone quiet", four times is "lost touch".
- [x] Desktop `/clients` page for both roles, opening on "Needs a call".
- [x] No internal vocabulary reaches the screen (`dormant`, `adopt`, tier
      letters).
- [x] Logging a call takes two taps and schedules the next one from the
      client's cadence.
- [x] Migration seeds the book from shipping history so it is useful on day
      one, with follow-ups spread over two weeks.
- [x] Attributing a PO to a client is audited but does **not** revert a
      submitted PO to Draft ([[RS-001]] shipped alongside v1.97.0's revert
      rule; this had to not trip it).

## Out of scope

- **The mobile shell.** The design exists
  (`docs/superpowers/specs/2026-08-29-clients-mobile-design.md`) and was
  deliberately not built — recorded, not implemented.
- Auto-creating a client when a shipping label is bought. Rejected on purpose:
  this business buys from plenty of people once, and auto-creating would bury
  the twenty relationships that matter. Sellers surface in a suggestion rail
  instead.

## Notes

- The work sat unpushed for three days while `dev` moved from v1.104.1 to
  v1.107.0. Shipping it needed a rebase, and its migrations `0112`/`0113`
  collided with dev's own `0112_merge_duplicate_parts_per_category.sql` — they
  are now `0113_suppliers.sql` and `0114_suppliers_backfill.sql`. Its commit
  claimed v1.105.0, a version `dev` had already tagged for a different PR;
  it ships as **v1.108.0**.
- Any machine that ran this branch before the renumber has
  `0112_suppliers.sql` / `0113_suppliers_backfill.sql` in `schema_migrations`.
  `0113_suppliers.sql` is not idempotent (`CREATE TABLE suppliers`), so those
  two ledger rows must be renamed or the next backend start crashes.
- `match_key` is a **generated column** and must never be re-implemented in
  TypeScript — `partNumberCanon.ts` documents what it costs when a JS canon and
  its SQL twin disagree about whitespace.
- The seeding migration groups on the compressed name that `match_key` derives
  from, *not* the punctuation-sensitive key `/api/shipping/contacts` uses:
  otherwise two spellings form separate groups and then collide on insert.
