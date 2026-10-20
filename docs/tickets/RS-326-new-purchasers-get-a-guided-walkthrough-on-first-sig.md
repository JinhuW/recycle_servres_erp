---
id: RS-326
title: New purchasers get a guided walkthrough on first sign-in
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: purchaser-onboarding-walkthrough
pr: "#791"
version: 1.299.0
related: []
---

## Ask

> create an onboard mode for new purchasers.
>
> I hope when new purchaser logined their system no matter desktop or mobile. the system can enter an onboard model for them to walkthrough the system and how they submit the product / get paid, etc.
>
> Pls fan out agents and understand all feature of this erp system first.

## Context

A new purchaser is created by a manager in Settings › Members with a temporary
password and nothing else: no email, no first-run screen, no help page. What
they have to learn before their first buy is spread over several screens and
several rules that only show up as refusals:

- "Submit order" saves a **Draft**; the real hand-off is **Mark as In
  Transit** on the PO page, which refuses without a warehouse, a source, a
  pickup or tracking number, and the payment proof that matches who paid
  (PayPal transaction ID, cash screenshot, or the seller chat for self-paid).
- Commission is `(sell price − cost) × rate`, 50% by default and set by a
  manager. **Ready to Pay** means it is owed, **Done** means it was paid, and
  neither waits for the goods to sell. A self-paid order also pays back the
  cost.
- Purchasers can edit until Ready to Pay; a material edit after hand-off sends
  the PO back to Draft for the manager to re-check.

No onboarding, tour or first-login state existed anywhere in the code (the
phone's PWA install card was the only first-run UI). `users.preferences` is
server-side and cross-device, so a preference key is where "has seen the
walkthrough" lives.

## Acceptance criteria

- [x] A purchaser who has never finished or skipped the walkthrough sees it
      on the first screen after signing in, on the desktop shell and on the
      phone shell.
- [x] It walks through: home numbers, adding products (with the shell's own
      entry point: Submit order on desktop, the camera button on the phone),
      the Mark as In Transit hand-off, the three payment proofs, the manager
      review and edit window, how commission is computed and paid, and the
      buying tools (Market, Clients, the Facebook account pool).
- [x] Each step that has a place in the app spotlights it: the sidebar item
      on desktop, the tab-bar item on the phone.
- [x] Back, Next, Skip, the arrow keys and Escape work, and focus stays in
      the walkthrough while it is open.
- [x] The walkthrough can switch between English and 中文 in place, and every
      string is in both dictionaries.
- [x] Finishing or skipping stores `onboarding.done` in the user's
      preferences, so it does not reappear on any device.
- [x] Users who had already signed in before this release start with the
      flag set: only people who are new to the app get it automatically.
- [x] Managers never get it automatically (previewing as purchaser
      included), but anyone can replay it: the Guide button in the desktop
      top bar, and Profile › Getting started on the phone.
- [x] The phone's install card stays hidden while the walkthrough is open.
- [x] The last step offers "Start my first order", which opens Submit on
      desktop and the capture flow on the phone.

## Out of scope

- Interactive, in-page coaching (pointing at fields on the submit form or the
  hand-off dialog while the user fills them in). The walkthrough explains the
  flow and points at where it starts; the forms already explain their own
  fields and refusals.
- A manager-facing tour, and a Members action to reset someone's
  walkthrough. A manager can replay it themselves to see what purchasers see.
- Fixing the "Order submitted" toast that fires when a Draft is saved, and
  the 佣金/提成 inconsistency in the Chinese copy. Both were found while
  mapping the flow; the walkthrough's own copy uses the code's actual
  behaviour and 佣金 throughout.

## Notes

- Built under a `/goal` run without a live plan review: the plan was drafted
  from five read-only agent reports covering roles and auth, the submit flow,
  the payment flow, both shells, and the rest of `docs/FEATURES.md`.
- Spotlight anchors are `data-tour` attributes on the sidebar leaves, the
  phone tab bar and the desktop Guide button, not text or class selectors,
  since every label is translated.
