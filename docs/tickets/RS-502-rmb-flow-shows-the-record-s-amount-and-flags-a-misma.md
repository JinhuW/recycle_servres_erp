---
id: RS-502
title: RMB Flow shows the record's amount and flags a mismatch
type: story
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/monkfish-2
pr: 1055
version: 1.406.0
related: []
---

## Ask

> Pls show another column about the amount in PO.
>
> For example, If it is comission, then it should show the commission in the PO, if the Purchase, it should show the total cost of the PO.
>
> if it is sale, then it should be sale total, ect

> if the amount has 2% mismatch, then it should show an red ! in the line of records.
>
> At the same time, it shoudl also alerts when user create the record.

## Context

The RMB Flow book (`DesktopAccounting.tsx`) showed each entry's Received / Paid
but not the figure of the record it pays, so a commission that didn't match the
PO's commission, or a purchase payment off from the PO's cost, stayed invisible
until Review mode. `findTargets` in `routes/accounting.ts` already worked out
the record's own figure (PO cost + other fees, projected commission, sell-order
total, case amount) and what the whole book holds against it (`recordedCny`)
for the drawer and Review mode; the book's `/entries` didn't send it.

## Acceptance criteria

- [x] The book has an "Order amount" column (zh 单据金额) between Method and Received, in the record's own currency: the PO's commission, the PO's total cost, the sell order's total, the case's amount. Blank for Other and for a deleted record.
- [x] A row whose record's book total (all live entries of that kind on it) is more than 2% off the record's amount shows a red ! beside the amount, with a tooltip giving both figures and the %. The record's USD figure converts at the latest CNY/USD rate.
- [x] Creating or editing an entry for a record shows a red warning under Amount when the total after this entry would be more than 2% off, and Save turns into "Save anyway", which needs a second click. Desktop dialog and phone sheet both.
- [x] A record with no figure never flags.
- [x] `/api/accounting/entries` returns `record` and `mismatch` per row; tests cover purchase, commission, sale, Other and the 2% edge.

## Out of scope

- Review mode's own record check (1% / ¥10, warns only when over) is unchanged.
- Blocking the save: the warning asks for a second click, nothing more.

## Notes

- The owner chose the book total over the single entry: a split payment flags every row of that record until the total balances.
