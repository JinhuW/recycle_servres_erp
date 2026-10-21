---
id: RS-340
title: Accounting page: an RMB ledger of what managers receive and pay
type: story
status: done
priority: P2
created: 2026-10-21
reporter: jinhu
branch: feature-accounting-page-ledger
pr: 812
version: 1.310.0
related: []
---

## Ask

> Create a new Accounting Page which is mainly record the money that manager received and paid.
>
> It should link with the PO, Sell order, After Sell system.
>
> for example A PO create by manager, then they can add a payment in the accounting, also a manger may also pay commission fee.
>
> same in the sell order, A manager may receive payment from clients.
>
> The main currency is RMB.

Answers given while planning:

- A commission entry fills the PO's *Commission paid by* when nobody is on file.
- Methods: Bank transfer, Alipay, WeChat Pay, Cash (and Other).
- Desktop and phone.

## Context

Managers pay suppliers for POs, pay purchasers their commission, take
customers' money for sell orders and refund after-sales cases, mostly in RMB by
bank transfer, Alipay, WeChat Pay or cash. None of that has a home today:

- *Payments* (FEATURES → Payments and reconciliation) reconciles Mercury and
  PayPal rows synced from the bank, and is USD-only — a non-USD bank row is
  kept out of every match (v1.198.3).
- A PO's commission records who paid it (*Paid by*, 0162 / 0187) and a
  screenshot, not the amount or how it was paid.
- Sell orders can be priced in CNY (0065); after-sales amounts are USD (0175).

## Acceptance criteria

The ledger

- [x] Manager-only: purchasers get 403 from `/api/accounting/*` and never see
      the page or its nav entry; anonymous callers get 401.
- [x] An entry records direction (Received / Paid), kind (Purchase,
      Commission, Sale, After-sales, Other), amount and currency (¥ by
      default, $ allowed), the CNY-per-USD rate frozen when it was recorded,
      method, date, the manager whose money moved, and an optional
      counterparty, reference and note. Entries are numbered `AC-1001`…
- [x] Purchase and Commission link a PO, Sale a sell order, After-sales a case,
      Other nothing; the API refuses any other pairing.
- [x] The kind sets the default direction (Sale received, the rest paid); it
      can be flipped for a refund.
- [x] Every total is RMB; a dollar entry counts at its frozen rate and shows
      its dollars beside it.
- [x] Entries can be edited, voided with a reason and restored; a voided entry
      leaves every total and balance. Each keeps a history.
- [x] A Paid Commission entry fills the PO's *Commission paid by* with its
      manager when nobody, not the company and no linked bank row is on file,
      with the same Activity line a pick by hand writes.

Desktop

- [x] `#/accounting` shows the period (default this month) and manager scope,
      the identity Opening + Received − Paid = Closing with a by-kind
      breakdown, and each manager's balance.
- [x] The ledger lists Date, Entry, For, Manager, Method, Received, Paid and a
      running Balance; kind / method / direction / search filters never change
      a balance.
- [x] A row (or `#/accounting/AC-…`) opens the entry with its history, Edit,
      Void and Restore.
- [x] The PO's Cost Payment and Commission tabs, the sell order and the
      after-sales case each show an Accounting card with their entries, the
      net, the record's own figure and a Record button pre-filled for it. The
      sell order's card includes its cases' refunds.

Phone

- [x] Home links managers to an Accounting screen with the period sum, each
      manager's balance and the entries by day; `+` records an entry, and an
      entry opens on its own screen with Edit / Void / Restore.
- [x] The phone PO page's Cost Payment and Commission folds show the order's
      entries and a Record payment button.

## Out of scope

- Feeding the Payments page's bank rows into this ledger — they are the
  company's USD accounts, reconciled there.
- Transfers between managers, opening balances.
- Dashboard, Activity-page and MCP integration.
- Attachments on entries.
- Writing back into a PO's cost, a sell order's revenue or an after-sales
  amount — entries are a record.

## Notes

- Balances are CNY at each entry's frozen rate. "Held by" a manager is what
  they received minus what they paid; below zero the company owes them.
- Dates are calendar dates as typed; the page's "today" is the viewer's own,
  since the managers keeping RMB books are hours ahead of Denver.
- Plan: `~/.claude/plans/cozy-doodling-sonnet.md` (session plan, not in repo).
