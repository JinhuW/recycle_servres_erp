---
id: RS-397
title: Make PO commission RMB Flow create-only
type: bug
status: done
priority: P2
created: 2026-10-25
reporter: jinhu
branch: fix/rmb-flow-create
pr: 898
version: 1.345.1
related: [RS-396]
---

## Ask

> FOr the RMB flow, I meant you add a create buttom.
> [Image #1]

> search is not required.

> Make sure create an user friendlt UIUX for it

Image #1 highlights the Record payment button below the commission transaction
search, in the RMB Flow card.

## Context

RS-396 added transaction search for both sources. The requester clarified that
RMB Flow should create a payment directly, while Business Account keeps its
transaction search. Reuse the existing record-payment form with the PO and
commission already selected, including its amount autofill and screenshot AI.

## Acceptance criteria

- [x] RMB Flow shows a prominent Create payment button and its recorded payments, without a
      transaction search field, candidate list, or unlinked-entry search request.
- [x] Create opens the existing payment form with this PO's commission selected.
- [x] Saving refreshes the ledger and payer; amount autofill and AI remain available.
- [x] Business Account retains transaction search and linking.
- [x] The creation action has concise explanatory copy and a comfortable phone touch target.
- [x] Desktop and phone expose the same flow, with English and Chinese labels.

## Out of scope

Changing the accounting API, the Business Account's payment rules, or production release.

## Notes

This corrects the already-approved payment UI work according to the requester's
explicit follow-up. Ship to dev under the standing authorization in AGENTS.md.


Verified: frontend typecheck, all 1,152 frontend tests, workspace build and
`git diff --check`. Headless Chromium on desktop (1440 px) and phone (390 px)
confirmed no RMB search input, candidate box or unlinked-entry search requests;
Create opens the PO-linked commission form and fills its native amount;
controlled OCR fills the amount; saving keeps the screenshot, updates the payer,
and refreshes the ledger. Business Account search/link still works. The phone's
Create payment target is at least 44 px high, and Chinese labels were checked.
