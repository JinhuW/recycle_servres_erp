---
id: RS-354
title: Accounting: an entry's Paid by and the PO's payer stay in sync; one company-wide balance
type: story
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: feat/po-paid-by-payer
pr: 826
version: 1.317.0
related: [RS-353, RS-349, RS-340]
---

## Ask

> Update the manager by payer.

> The Entry should be the unique key globally.

> no, i meant the info can sync. for example. If i paid in the PO-1234 and
> link the AC-1000. Then it should bidirectly link.

## Context

RS-340 opened the managers' RMB book with `accounting_entries.manager_id
NOT NULL`: whose money moved. RS-349 booked commissions from the PO's
commission *Paid by*, and a commission entry fills that field when nobody
is on file; the PO never writes back. RS-353 named the cost payer and let
the PO read *Business Account* when the company paid — but the book could
not say so, and an entry written under Jinhu kept reading Jinhu after a
PayPal row was linked as the commission and the PO flipped to Business
Account (PO-1439 / AC-1038).

Jinhu asked for the two records to be one linked value: an entry linked to
a PO and the PO's payer stay in sync in both directions, with Business
Account a value on both sides, and for the ledger's running balance to be
the company's single book rather than one per manager.

## Acceptance criteria

- [x] The ledger column reads Paid by: a person by name, or Business
      Account. Desktop and phone ledger, the entry drawer, the PO cards.
- [x] PO → entry: changing a PO's commission payer, linking or unlinking a
      Mercury/PayPal row as its commission, or changing its cost payer or
      payment, updates its live entries of that kind, with an entry history
      line. Nobody on file leaves the entry alone. A restored entry catches
      up with its PO.
- [x] Entry → PO: saving a commission entry with Paid by X sets the PO's
      commission Paid by to X (Business Account = company paid), with the
      PO's Activity line; refused while a bank row is linked as the
      commission. Saving a purchase entry with Paid by a person sets the
      self-paid PO's cost payer; Business Account on the cost side is set
      on the PO only.
- [x] The Record / Edit form's field reads Paid by and offers Business
      Account and the managers (and the PO's purchaser for a cost entry);
      it is locked when the PO decides (a linked commission row, a
      company-paid cost).
- [x] The Paid by filter offers Everyone · Business Account · each payer;
      Held by shows a Business Account balance.
- [x] The Balance column runs over the whole book whatever the filter.
- [x] Existing live PO-linked entries are brought in line with their PO
      once, with a history line.

## Out of scope

- Flipping a PO's cost between Business Account and a person from the
  book: that needs the Method and the proof rules, so it is done on the PO.
- Paying a manager back; per-payer reports.

## Notes

- **Superseded in part by RS-355 (same release):** the Business Account is
  not a payer in the RMB book after all. `manager_id` stays NOT NULL, the
  form, filter and Held by offer people only, and a PO the Business Account
  paid voids its entries instead of carrying them. The person-to-person
  link and the one company-wide balance stand as written here.
- PO → entry runs in the database (migration 0199: `accounting_sync_payer`
  and two triggers), so every writer is covered — the PO page, the
  commission screenshot fill, bank link / unlink / pair, the bank sync's
  settle-status flips, a PO delete — without a hook in each route.
- A self-paid PO's cost payer can be its purchaser; the column, the filter
  and Held by then name a purchaser.
- Deleting a draft PO unlinks its bank rows before the delete, so a
  commission entry on a linked Business Account PO lands on the PO's
  on-file person, then reads as unlinked.
- Supersedes RS-353's "no Business Account money in the RMB book".
- Plan: `~/.claude/plans/mossy-hopping-dijkstra.md` (session plan, not in
  repo), reviewed twice; the first draft derived the payer on read and was
  redone when Jinhu said the link must sync both ways.
