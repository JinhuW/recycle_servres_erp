---
id: RS-355
title: Accounting groups Payments and RMB Flow; the RMB Flow records money outside the Business Account
type: story
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: feat/po-paid-by-payer
pr: 826
version: 1.317.0
related: [RS-354, RS-353, RS-340]
---

## Ask

> I made some mistake here.
>
> Let we put the payment page and accounting page in the same Accounting Nav bar.
>
> Renaming the current accouing page into "RMB Flow".
>
> Let me clarify that the RMB flow is mainly for recoding the payment not going
> throug the business account, all business acount payment should belongs to
> the payment right now.

## Context

RS-354 (same release) let the RMB book name the Business Account as a
payer, so an entry could follow its PO when a Mercury/PayPal row was linked
as the commission. Jinhu's clarification draws the line the other way: the
company's own money is Payments' — the USD bank, reconciled there — and the
RMB book records what managers paid and received *outside* it. The two
pages belong under one Accounting heading, and the book is the **RMB
Flow**.

So an entry on a PO the Business Account paid has no place in the RMB Flow.
When a PO's payer becomes the Business Account, its live entries are voided
with the reason, restorable; recording one there is refused; and the RMB
Flow's Paid by offers people only. A person payer keeps flowing both ways.

## Acceptance criteria

- [x] Desktop sidebar: Oversight has an Accounting parent (as Monitors) with
      Payments and RMB Flow under it; Payments stays lit on Internal
      transactions; a purchaser sees neither. Both pages print the
      "Accounting / …" breadcrumb Monitors' pages print. URLs unchanged.
- [x] The RMB book is named RMB Flow everywhere it was Accounting: page
      title and subtitle, the PO / sell order / case card, the phone Home
      link and screen title.
- [x] RMB Flow's Paid by offers the managers (and the purchaser on a
      self-paid cost), never the Business Account; no Business Account
      filter, Held by row or balance.
- [x] When a PO's commission becomes company-paid (on file, or a
      Mercury/PayPal row linked as it) or its cost flips to the company's
      account, its live paid-out RMB entries of that kind are voided with
      the reason "Paid from the Business Account" and a history line; totals
      drop them. Unlinking / clearing does not restore them; Restore does,
      and a restored entry is never voided by the PO again.
- [x] Recording an RMB entry on a PO the Business Account paid is refused;
      the form and the PO card say so and point to Payments.
- [x] A person payer still flows both ways (RS-354).
- [x] Existing live entries on a company-paid PO are voided once, with a
      history line saying so.

## Out of scope

- A Payments screen on the phone (none exists today).
- Renaming the `#/accounting` URL.

## Notes

- Supersedes RS-354's Business Account payer; `accounting_entries.manager_id`
  stays NOT NULL. Migration 0199 is rewritten in place: it had run nowhere
  but CI and a local dev database.
- The one-off void reaches production rows (PO-1439 / AC-1038 among them);
  each keeps its history and can be restored.
- The triggers fire on every PO save and every settlement flip, so the void
  skips any entry that carries a `restored` event: a manager's restore is
  the last word.
- Plan: `~/.claude/plans/mossy-hopping-dijkstra.md` (session plan, not in
  repo), reviewed once.
