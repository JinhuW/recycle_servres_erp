---
id: RS-550
title: RMB Flow compares a commission entry to what the purchaser earns
type: bug
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/booby-2
pr: 1110
version: 1.427.1
related: [RS-502, RS-524]
---

## Ask

> It is counting wrong here.
> [Image #1]
>
> The order does not count the total earn.
>
> It only count the comission, some order it also include selfpay  + earn.

## Context

RMB Flow's Order amount and red mismatch flag (RS-502, RS-524) read a commission
entry's figure from `findTargets` in `routes/accounting.ts`, which was only the
projected commission. The PO's Commission tab states what the purchaser is paid
as self pay + commission (`reviewMoney`, `costReimbursedToOwner`), and a purchaser
who paid the cost personally gets both in one transfer. So those rows read
300–4,500% over.

In the dev copy of prod, 40 POs have commission entries. All six self-paid rows in
the report's screenshot are within 1% of cost + commission. Flagged POs drop from
18 to 7 at about ¥6.667 per USD.

## Acceptance criteria

- [x] A commission entry's record figure is commission + the PO's cost with fees when the purchaser paid the cost themselves (`payment = 'self'`, payer is the owner or none on file).
- [x] On company-paid POs and POs another manager paid, the figure stays commission only.
- [x] A PO with no commission rate stays "no figure" unless it is self-paid.
- [x] The Order amount column, red flag, form warning, Review mode check and new-entry amount all use that figure, because they all read it from `findTargets`.
- [x] The label reads "Purchaser earns" / 采购员收益 instead of "Projected commission" / 预计佣金.
- [x] Tests cover self-paid by owner, self-paid by another manager, and company-paid.

## Out of scope

- Business Account commission matching (`commissionCandidates` in `routes/bankTx.ts`). It has its own copy of the commission figure and nobody reported a problem there.
- Correcting existing entries. The flag is display only, and no stored data changes.
- Subtracting a separate purchase entry from self pay (the PO-1490 case). The book can't tell a purchase entry that repaid the purchaser from one recording that the purchaser paid the supplier.

## Notes

- Newly flagged, expected: PO-1384, PO-1460 and PO-1478 are self-paid and booked at commission only, with no purchase entry or linked bank row. PO-1490 is self-paid with a $0 projected commission, a ¥10,051 commission entry and a separate ¥67,047 purchase entry.
- The commission stays clamped at zero, as on the bank picker. On a self-paid PO sold at a loss, the PO page's earns figure is lower than this one, because it doesn't clamp.
