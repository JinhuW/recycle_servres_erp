---
id: RS-402
title: Home becomes a role-specific highlights page; the dashboard moves to Analysis
type: story
status: done
priority: P2
created: 2026-10-25
reporter: jinhu
branch: feat/home-highlights
pr: 907
version: 1.350.0
related: []
---

## Ask

> You are an expertise in the ERP system. deep review my ERP system.
>
> I would like to move current dashboard into an anaylysis page and update the current home page to a highlight page to tracking important information.
>
> for example Purcher knwo the progress of PO.
>
> Manager know the coming package, due to reviewing, etc.

## Context

Both shells land on the Dashboard (`/` → `dashboard`, `lib/route.ts`), a money
report over a reporting window (`GET /api/dashboard`). It says how the business
did, not what is waiting on the viewer. The work queues live on a dozen pages;
the only cross-page signals were the RMB-review sidebar badge and the phone's
inbound-packages card.

What the review found that shapes the design:

- Two roles, `manager` and `purchaser`; `effectiveRole()` lets a manager
  preview as a purchaser.
- POs carry no stage-changed timestamp. Days-in-stage is the newest
  `order_events` row of kind `submitted` / `advanced` / `reverted`, else
  `orders.created_at`.
- No endpoint counted POs by stage. Count logic that already existed is reused
  so Home agrees with the pages it opens: the inbound-counts buckets,
  `reviewTabFrag`, `openRowFrag`, `unackedRevertFrag`, the sign-off fingerprint.
- List pages kept their filters in persisted state only, so nothing could
  deep-link to "Reviewing".
- The desktop has no notifications UI (phone only).

Decisions confirmed with the requester: one Analysis page with tabs (Sales &
profit for both roles, Inventory for managers); both shells change; the manager
Home carries all four groups (inbound & review, money to move, sales pipeline,
other queues).

## Acceptance criteria

- [x] `/` opens Home on both shells; unknown paths fall back to Home.
- [x] The sidebar lists Home first and Analysis second, for both roles.
- [x] `/analysis` shows the former dashboard unchanged.
- [x] `/analysis/inventory` shows the stock analysis to managers; a purchaser
      is bounced to `/analysis`.
- [x] `/dashboard` and `/inventory/analysis` land on their new homes.
- [x] A purchaser's Home shows their PO counts per stage, their open POs with
      stage, days in stage and package ETA, drafts with a blocker hint, their
      incoming packages and exceptions, commission owed and paid in 30 days,
      and supplier follow-ups due — and nothing of a peer's, no manager keys.
- [x] A manager's Home shows Inbound (arriving today/tomorrow, in transit,
      exceptions, delivered without a PO, pickup POs in transit), Review
      (Reviewing POs with age, box-check progress, open AI findings, assigned
      to me; unacknowledged reverts), Money to move (Ready-to-Pay POs and
      commission, sell orders awaiting payment, unlinked bank rows, disputes),
      Sales pipeline (Draft sell orders with connector-made ones flagged,
      Packing progress, sign-offs waiting on me) and Other queues (RMB review
      for me / asked, open after-sales, pending transfers, new web
      submissions).
- [x] Home counts match the pages they open; tests pin parity with
      inbound-counts, RMB review count and the bank unlinked tile.
- [x] A manager previewing as a purchaser gets the purchaser Home.
- [x] The PO list honours `?stage=` and the sell-order list `?status=`.
- [x] The phone Home shows the same highlights as compact cards with Scan with
      AI and the bell; the old money view lives at Numbers (`/analysis`).
- [x] `docs/FEATURES.md` has a Home section; Dashboard is renamed Analysis.

## Out of scope

A desktop notifications bell; per-user Home customisation; push or email
digests; a stage-changed-at column; configurable staleness thresholds.

## Notes

Staleness tints are constants: amber at 3+ days in a stage, red at 7+.
