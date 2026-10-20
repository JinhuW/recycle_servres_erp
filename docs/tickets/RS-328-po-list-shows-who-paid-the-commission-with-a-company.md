---
id: RS-328
title: PO list shows who paid the commission, with a Company paid option
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: po-paid-by-column
pr:
version: 1.301.0
related: []
---

## Ask

> In the PO page table add and new filed called paied by.
> [Image #1]
>
> It should note which mamager paid the commission fee and a new option for company paid(does not need to come from DB for company option and the manager list should come from DB), Once a payment linked to a commission then it shoudl show company paid.

Image #1: [assets/RS-328-po-list.png](assets/RS-328-po-list.png)
— the desktop Purchase orders list at 13 of 13 columns, Commission and
Payment side by side.

## Context

Since v1.217.0 a PO records **which manager paid the purchaser their
commission**: `orders.commission_paid_by` (migration 0162), set through
`PUT /api/orders/:id/commission-paid-by` (`routes/orders/evidence.ts`) from the
*Paid by* select on the desktop Commission tab and the phone Commission fold
(`components/CommissionPaymentFields.tsx`, `lib/useCommissionPaidBy.ts`). The
select offers the active managers or *Not recorded*. The record lives only
on the PO page: the list (`GET /api/orders`, `pages/desktop/DesktopOrders.tsx`)
never carries it, so finding the unpaid commissions means opening POs one by
one.

The commission is not always paid by a manager in person. Sometimes the
company's own account pays it, and since v1.257.0 that bank row can be linked
on the Payments page as the PO's commission (`bank_transactions.link_kind =
'commission'`). Nothing reads that link as "the company paid". The paid-by
column is a user FK, so it has no way to name the company.

## Acceptance criteria

- [x] The desktop PO list has a **Paid by** column, right after Commission.
      It is in the Columns picker, on by default, and also switched on for
      anyone whose saved column list predates it.
- [x] A manager can pick in the cell: *Not recorded*, *Company paid*, or any
      active manager (the managers come from the members API). The pick saves
      at once, as it does on the PO page. Other roles read the value.
- [x] *Company paid* is a fixed option, not a user row. It is stored as
      `orders.commission_paid_by_company`, and a CHECK keeps it from
      coexisting with a manager.
- [x] The PO page's Paid by select, on desktop and phone, offers the same
      *Company paid* option.
- [x] Once a live bank payment (not failed or reversed) is linked as the PO's
      commission, Paid by reads **Company paid** everywhere: the list, the PO
      page and the API. It cannot be changed by hand while the link stands,
      and the PUT refuses with a 409. Unlinking it brings back whatever was
      recorded by hand.
- [x] A change is one *Commission paid by: ‹from› → ‹to›* Activity line, the
      company written as "Company".
- [x] The column sorts.

## Out of scope

- The phone order list has no columns, so it gets no Paid by. The phone
  Commission fold gets the Company option through the shared component.
- A Paid by filter chip on the list.
- The PO spreadsheet export.
- Writing the company flag when a bank row is linked. The link is read live,
  so unlink, group and transfer need no new code path to keep it right.

## Notes

- The preferences backfill is its own migration (0188), separate from the
  schema change (0187), so `tests/me-preferences.test.ts` can replay it the
  way it replays 0186. Replaying 0187 would fail on the existing column.
- Verified on the local stack (Playwright, alex and marcus). The cell pick
  saves without opening the line drawer and survives a reload. A commission
  link turns the cell into a *Company paid* chip that opens
  `#/payments/po/<id>`, the Commission tab's select locks with its note, and
  the PUT returns 409. After the unlink, the hand pick shows again.
- The API's `commissionPaidBy` becomes `{ kind: 'manager', id, name }`,
  `{ kind: 'company', linked }` or `null`. A manager record keeps `id` and
  `name`, so a stale SPA still reads it. A stale SPA shows a company record
  as *Not recorded* until it reloads.
