---
id: RS-076
title: Dev-to-main review findings before the prod cut
type: bug
status: in-progress
priority: P2
created: 2026-09-18
reporter: jinhu
branch: session/20260918-202813
pr:
version:
related: [RS-069, RS-071, RS-074]
---

## Ask

> /code-review high dev -> main, fix all issue and release to prod.

## Context

A `high`-effort review of the diff a `dev` → `main` release would ship
(`origin/main...origin/dev`: v1.150.0 – v1.155.0, six PRs) returned three
findings, all verified against source.  None blocks a release; the first sits
squarely in the RS-071 / RS-074 flow, whose new readiness list steers a
purchaser into the exact sequence that trips it, so this is the cheap moment
to fix them.

| | Where | Cost if shipped |
|---|---|---|
| 1 | `lib/useHandoffForm.ts` | The hand-off dialog and phone sheet build a **second** `usePaymentProof` seeded from the `order` prop, which the page never refetches after an upload.  Company-cash Draft → readiness row → upload the cash screenshot on the page → row turns met → Submit → the sheet opens with zero proof files, `hoNeedCashShot` blocks, Confirm is disabled.  The user uploads the same file twice (a duplicate attachment) or reloads.  Upload in the sheet then Cancel leaves the page stale the other way. |
| 2 | `lib/handoff.ts`, `DesktopEditOrder.tsx` | `txnRequired` / `cashShotRequired` are computed by the server for the *saved* paid-by and method.  A saved cash order has `txnRequired: false`; flip it to PayPal in the dialog and leave the id blank and the client says ready, the server 409s `missingTxnId`.  Mirror case for PayPal → Cash.  The phone readiness list shows no row at all in that state. |
| 3 | `routes/orders.ts` `/advance` | The pre-tx PayPal pull (a live Transaction Search plus the dispute list) ran before the tx's `archived_at` check and for any id — including the fourteen prod POs carrying `CASH` / `WAIT` / `TIM` placeholders that can never match.  One PayPal round-trip per Submit click, no throttle beyond the process single flight. |

## Acceptance criteria

- [ ] The hand-off dialog and the phone sheet read the same `usePaymentProof`
      instance as the page: a cash or chat screenshot uploaded on the PO page
      counts in the dialog without a reload, and one uploaded in the dialog
      shows on the page after Cancel.
- [ ] `handoffBlockerKeys` exempts a PayPal order only when the saved order
      was company-paid and not cash, and a cash order only when the saved
      order was company-paid cash; flipping the method in the dialog with the
      proof missing shows the blocker.  Unit-tested.
- [ ] The desktop edit page's Save blockers apply the same rule, including a
      saved self-paid order flipped to company in a manager stage jump.
- [ ] `POST /api/orders/:id/advance` pulls PayPal only for a non-archived
      Draft whose id has the canonical 17-character shape; a placeholder id
      is refused without a pull.  Integration-tested with the stub provider.
- [ ] Backend and frontend suites, typecheck green; `dev` then `main` carry
      the release.

## Out of scope

- Routing the desktop Save blockers through `handoffBlockerKeys` wholesale:
  it would newly block on `hoNeedMethod`, which is behaviour, not a fix.
- The `*` star on the transaction id (`txnRequired === true`) still follows
  the saved verdict and does not light up on a flipped method.  Cosmetic.
- A legitimate PayPal id in a non-canonical shape (shorter or longer than 17)
  now waits for the six-hourly sync instead of pulling; the refusal already
  says to try again later.

## Notes

- Refetching the phone page after an upload was considered for #1 and
  rejected: `OrderDetail.tsx` keys its typed-fields draft on `serverVersion`,
  which includes the attachment ids, so a refetch would wipe the user's
  unsaved picker edits.  Sharing the page's hook is the fix.
- Sharing the hook means a PayPal screenshot scanned inside the dialog now
  lands in the page's transaction-id field too, and the dialog follows it.
  On desktop that leaves the page dirty if the dialog is cancelled — the id
  was read and is worth keeping.
- The local backend suite could not verify this branch: the Docker VM was
  CPU-starved by another project's containers and every `CREATE DATABASE`
  clone sat in fsync, so the run timed out across unrelated files.  CI's
  `backend-tests` job is the verification; see
  `docs/debug-notes/2026-09-19-local-backend-suite-crawls-when-docker-vm-is-starved.md`.
