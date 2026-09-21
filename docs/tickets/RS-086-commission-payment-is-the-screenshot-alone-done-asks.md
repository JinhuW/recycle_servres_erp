---
id: RS-086
title: Commission payment is the screenshot alone; Done asks for it only when missing
type: story
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-085-commission-screenshot
pr:
version: 1.165.0
related: [RS-084]
---

## Ask

> The commission payment do not select need to select from options. Only need
> to ethe payment screenshot.
>
> When user move from Ready to pay to Done. It will check if screenshot has
> been attached. if not, it will prompt an dialog which is how it is right now.
> But it already has then we can smoothly move to done.

Follow-up answers: the dialog is a **prompt only** — Confirm still works with
nothing attached, no gate on the client or the server; and the block is
**screenshot only** — the transaction-ID field goes too, the OCR result is
neither shown nor stored.

Mid-build, on seeing the first cut:

> The outside box of the dropping file is not required.
> [screenshot: the drop box inside a bordered panel with a left rule]

## Context

RS-084 (v1.163.0) gave the desktop Commission tab and the phone Commission
fold a *Commission payment* block: a PayPal | Cash picker, a transaction ID
filled by OCR from a dropped screenshot, and the screenshot itself in a
manager-only `Commission` status-meta bucket, all live-saved through
`PUT /api/orders/:id/commission-payment`. Jinhu wants only the screenshot.

The record therefore collapses to files in the `Commission` bucket, and the
existing *Mark order as Done* dialog (`StatusChangeDialog`, PO variant)
becomes the fallback place to attach one: it opens on the way to Done only
when no commission screenshot is on file, and its attachments land in the
Commission bucket so the tab and the dialog show one list. Its closing note
stays on the `Done` bucket as before.

## Acceptance criteria

- [x] The Commission tab (desktop) and fold (phone) show no PayPal/Cash
      picker and no transaction ID — only the screenshot drop box, its
      files, and (for purchasers) a read-only list.
- [x] Ready to Pay → Done with a commission screenshot on file moves without
      any dialog: the desktop stages Done for Save, the phone advances.
- [x] Without one, the Done dialog opens, asks for the commission payment
      screenshot, and a file attached there appears in the Commission
      tab/fold; Confirm is not gated on it.
- [x] `orders.commission_method` / `commission_txn_id` and the
      `/commission-payment` route are gone; uploads carry no `scan` field.

## Out of scope

- A gate (client or server) on the screenshot — asked, answered "prompt only".
- Reading the transaction ID off the screenshot for any purpose.

## Notes

- Consequence worth stating: a PO that already has a screenshot never shows
  the Done dialog again, so its closing note (the `Done` bucket note) can no
  longer be typed from either shell — the dialog was the only place that
  edited it. Asked for; not a regression.
- The screenshot state lives in `usePaymentProof` as a third bucket (the
  `Commission` bucket has the same add/remove/sync shape as `Submission` and
  `Payment`); RS-084's `useCommissionPayment` hook is deleted. Its `busy`
  flag excludes the Commission bucket, which feeds the hand-off sheet's
  `canSubmit`.
- `StatusChangeDialog` takes an optional `attachments` store so the PO pages
  can hand it the Commission list; sell orders are unchanged.
- Plan: `~/.claude/plans/cosmic-plotting-snowglobe.md`.
