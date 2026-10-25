---
id: RS-396
title: Search commission transactions and autofill payment amounts
type: story
status: done
priority: P2
created: 2026-10-25
reporter: jinhu
branch: JinhuW/yellowtail
pr: 897
version: 1.345.0
related: []
---

## Ask

> update the ui for taking care of payments.
>
>
> image file: /Users/jinhu/.codex/attachments/00ae5700-c88d-4352-bfe9-261b584e906b/image-1.png
> update this section from image drop and name select to RMB Flow or Business Account transaction search.
>
>
> image file: /Users/jinhu/.codex/attachments/00ae5700-c88d-4352-bfe9-261b584e906b/image-2.png
>
> The amount can be auto adjust by two part.
>
> One is from the linekd PO info or sell order info. Second way is coming from the ai recognized content.

> push to dev

> Keep in mind, alwasy feel free to push to dev

## Context

The commission panel uses a standalone payer select and screenshot dropzone,
separate from its RMB Flow and Business Account ledgers. Replace these controls
with transaction search and linking. The shared accounting form currently only
prefills an amount for a CNY sale opened from its order; receipt OCR introduced
in v1.333.0 only renames files, without filling the amount.

## Acceptance criteria

- [x] The PO commission panel searches RMB Flow entries or Business Account
      transactions and links the selected payment as commission.
- [x] Existing linked payments and legacy screenshots remain visible.
- [x] Linked commission payments satisfy the PO Done flow without another screenshot.
- [x] New accounting entries prefill amounts from PO cost, projected commission,
      or sell-order total with correct CNY/USD conversion; manual edits remain possible.
- [x] Payment screenshots are read before saving and their recognized amount
      and currency can fill the form; users can choose order or receipt amounts.
- [x] Both shells use the shared behavior and English/Chinese translations.
- [x] Relevant tests, typecheck, build, and visual verification pass.

## Out of scope

Changing PO costs or sell-order revenue when a payment is recorded; changing
the two fixed commission payment types; releasing to production.

## Notes

Plan approved by the requester in this session on 2026-10-25. Existing bank
linking and accounting-entry mutation rules remain authoritative. Searches
must not silently take a payment already linked to a different record.


Verification: `pnpm typecheck`, `pnpm build`, and the frontend suite on the latest dev base (94 files,
1,152 tests) pass. Backend payment/accounting/commission suites pass; the final receipt, rename,
evidence and form-source suites pass (49 tests).
Headless Chromium against a disposable PostgreSQL 18 database verified desktop
and phone transaction search/linking, cancellation, payer and void updates,
PO cost/commission and sell-order amount filling, currency conversion, a manual
edit while recognition was pending, switching sources, removing a screenshot,
saving the entry and its attachment, and Done with a linked bank/RMB payment.
A separate phone check confirmed the link dialog, real RMB linking, legacy
screenshot visibility without the old controls, and Chinese search/form labels.
Receipt recognition used controlled model replies, not a live paid model call.
Backend changes should deploy before the frontend; no database migration is
needed. The requester subsequently authorized shipping to dev and standing dev
push authorization is recorded in AGENTS.md. Production release remains
separate.
