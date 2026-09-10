---
id: RS-036
title: Add a note to a payment
type: story
status: in-progress
priority: P2
created: 2026-09-09
reporter: Jinhu
branch: feat/payment-notes
pr:
version:
related: [RS-011, RS-016]
---

## Ask

> Add a feature that user can add an note to the payments.

## Context

The Payments page (manager-only, desktop) lists Mercury and PayPal
transactions and every verdict a manager can put on one — a linked PO, a
transfer, ignored, an owner. None of those is a place to write *why*. The one
note in the area is on an internal-transaction record (v1.119.0), which groups
several rows; a single payment has no text field of its own, so the reason a
$600 debit exists, or what a seller promised about a refund, lives in chat.

A note is stored on the bank row, on every leg of a paired payment (the feed
renders only the PayPal leg), stamped with who wrote it and when, and treated
like the owner tag when two groups are paired by hand: a lone note spreads,
two different notes refuse until one is cleared. Automatic pairing is left
alone; the feed reads the note across the group instead.

## Acceptance criteria

- [x] `POST /api/bank-transactions/:id/note` sets or clears a note on every
      leg of the payment, stamping `note_by` / `note_at`; manager-only; 280
      chars max; empty clears.
- [x] The feed row carries `note { text, at, byName }` and `?q=` matches note
      text.
- [x] Pairing two legs by hand spreads a lone note and refuses two differing
      ones; a note on either leg of an auto-paired payment shows on the row.
- [x] Expanded row has a note editor (save / clear) with author and date; the
      collapsed row shows the note under the payee.
- [x] EN + ZH strings; i18n parity test green.

## Out of scope

- A note thread / history per payment (one note, overwritten in place).
- Showing the note on the PO's payments ledger.
- Notes on the mobile shell (Payments has no mobile page).

## Notes

- Group-wide storage rather than a side table: mirrors `assignee_id`; a side
  table keyed by pair would break on unpair.
- The note is resolved read-side with a lateral over the pair, so neither
  `autoPair` nor `transferPair` in the sync needed a spread rule.
