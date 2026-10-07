---
id: RS-185
title: Commission payment records which manager paid it
type: story
status: done
priority: P2
created: 2026-10-07
reporter: jinhu
branch: feat/commission-paid-by
pr: 517
version: 1.217.0
related: [RS-084, RS-086]
---

## Ask

> Why the paid by feature in the PO is not available?

(answered about the Cost Payment *Paid by* picker, which locks at Ready to Pay)

> I meant which maager paied the commission fee

Offered: *"1. A "Paid by" manager picker in the Commission payment box, saved
on the PO and logged in Activity."* / *"2. Show the uploader's name on each
screenshot."*

> #1 my goal

## Context

A PO carries two payments: the cost payment (Cost Payment tab — *Paid by*
Company card / Self-paid) and the commission paid to the purchaser (the
*Commission payment* box on the desktop Commission tab and the phone
Commission fold). RS-084 (v1.163.0) gave the commission payment a method and a
PayPal transaction id; RS-086 (v1.165.0) cut it back to a screenshot in the
manager-only `Commission` status-meta bucket. Nothing records which manager
paid — the Activity log names who *uploaded* the screenshot, which need not be
the payer.

The commission is paid once the PO is a closed book (Ready to Pay → Done),
where Save is off and `PATCH /api/orders/:id` refuses frozen fields, so the
record writes through on its own endpoint, as the screenshot does.

## Acceptance criteria

- [x] The desktop Commission tab and the phone Commission fold show a *Paid by*
      field in the Commission payment box: a manager picks from the active
      managers (or clears it); everyone else sees the name, or "Not recorded".
- [x] The choice saves as it is made, at every stage including Done, without
      the page's Save; it survives a reload.
- [x] `PUT /api/orders/:id/commission-paid-by` is manager-only (403 otherwise)
      and accepts only an active manager or `null` (400 otherwise).
- [x] `GET /api/orders/:id` returns `commissionPaidBy: { id, name } | null`.
- [x] Each change writes one Activity entry, "Commission paid by: <from> →
      <to>", with names as they were at the time — on the PO's Activity tab and
      the desktop Activity page. Re-saving the same manager writes nothing.

## Out of scope

- The *Mark order as Done* dialog — it keeps the screenshot box only.
- Defaulting *Paid by* to the screenshot's uploader or the PO manager: NULL
  until a manager picks, as RS-084 kept the first real choice an audited
  change rather than a default every historical order silently claims.
- Gating Done on it — like the screenshot, it is a record, not a gate.
- Backfilling historical POs.

## Notes

- Plan: `~/.claude/plans/mighty-wiggling-conway.md`.
- "Active manager" is `isActiveManager`, moved from `routes/sellOrders.ts` (the
  sell order's *payment received by* picker) into `services/members.ts` so both
  pickers share one definition. The manager list comes from `/api/members`
  filtered by role in the browser, as the sell-order picker does.
- Numbers: RS-184 / v1.213.0 / migrations 0160–0161 went to a peer session
  (`fix/po-line-qty-zero`), so this ticket took RS-185 and 0162. It was first
  bumped to v1.214.0; RS-186 then landed v1.216.0 ahead of it, so it ships as
  v1.217.0 (1.215.0 had been claimed by another peer).
