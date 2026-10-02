---
id: RS-155
title: "Re-review fixes: unpair tombstone, /64 budgets, limiter eviction, leave guard on navigation, Unicode supplier keys"
type: bug
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/rereview-v1200
pr: "#474"
version: 1.200.1
related: [RS-143, RS-151, RS-153, RS-154]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

The approved plan, `docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`,
ends with "a short re-review (`/code-review high`) over `v1.194.0..HEAD`". This
ticket holds the fixes for what that re-review found in batches 3a–8b
(RS-141…RS-154).

## Context

The re-review returned 10 findings, and each one was checked against `origin/dev` at
v1.200.0. Seven are defects:

- **`/unpair`:** after ungrouping, the Mercury leg still carries the PayPal id parsed from its
  description. The next sync's `autoLink` linked it back to the PO, so the payment counted
  twice. That double count is the state the v1.198.3 change set out to remove.
- **Per-address budgets:** the public forms' per-address daily share and the DCR per-IP
  throttle compared stored full addresses. An IPv6 sender rotating inside its /64 started
  each request with a fresh count.
- **Rate limiter:** at its key cap, the in-memory limiter evicted oldest-inserted keys first,
  and the throttled key was usually the oldest. So a flood of fresh keys reset its budget.
- **Unsaved-edit guard:** it ran only on each screen's own Escape, Cancel and Back. Sidebar,
  tab bar and record links, and browser Back/Forward, still dropped edits silently. The
  phone PO screen had no guard at all.
- **Supplier name keys:** `supplier_name_key` fell back to the exact name only when no A–Z or
  0–9 survived. Mixed-script names collapsed to their Latin residue: 'Đức' keyed as 'C', and
  '王 RAM' and '李 RAM' both keyed as 'RAM'.
- **Web-submission purge:** a converted submission that was later archived by hand was
  deleted after 30 days, taking the seller's provenance for the PO with it.
- **Phone Market:** a slow "Load more" could append the previous filter's page to the new
  results.

The other three are cleanups:

- the sellable-inventory query evaluated the committed-qty subquery twice per row;
- the inventory PATCH had its own copy of `specVal`;
- a login flood against a locked email cost three writes per request.

Prod (read-only, 2026-10-02) has 1 supplier with no non-ASCII names, 2 web submissions with
no IPv6, and no split PayPal/Mercury links. Nothing needs a data repair.

## Acceptance criteria

- [x] **Unpair:** after `/unpair` and a re-sync, the Mercury leg of a PayPal pair stays
      unlinked (`no_auto_link`), and the PayPal leg keeps the PO.
- [x] **Per-address budgets:** two IPv6 addresses in one /64 share the public forms'
      per-address daily share and the DCR per-IP count.
- [x] **Rate limiter:** a throttled key is still refused after the key cap is flooded with
      fresh keys.
- [x] **Unsaved-edit guard:**
  - [x] Sidebar, tab-bar and record links ask before leaving unsaved edits, and so do browser
        Back and Forward.
  - [x] A save that then navigates never asks.
  - [x] Moving between the phone PO's two screens never asks.
  - [x] Discarding on the phone really discards.
- [x] **Supplier name keys:** a name with any non-ASCII character keys on its exact (trimmed,
      lower-cased) text, so 'Đức' ≠ 'Ức' and '王 RAM' ≠ '李 RAM'. ASCII names key as before.
- [x] **Purge:** the purge never deletes a submission that has an `order_id`.
- [x] **Phone Market:** "Load more" drops a page whose filter or search is no longer current.
- [x] **Cleanups:**
  - [x] the committed-qty subquery runs once per row in the sellable search;
  - [x] there is one `specVal`;
  - [x] a locked login writes no `login_attempts` row.

## Out of scope

- Moving the per-screen Cancel buttons onto the navigation guard: they already ask.
- GET /api/inventory's per-row subqueries, which each run once per row.

## Notes

- **Leave-guard design:** `route.ts` exposes `setLeaveGuard({ wouldAsk, ask })`, and the guard
  module installs it, so routing gains no import.
  - **Self-navigations:** `navigate`, `replaceRoute` and `navigateBack` are counted and pass
    straight through.
  - **Other hash changes:** these are restored from `oldURL` while the dialog is up, then
    stepped back if the user confirms.
  - **A second Back while the dialog is open:** it is restored silently, without asking again.
