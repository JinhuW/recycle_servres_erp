---
id: RS-389
title: Fix what the dev-to-prod review found before releasing v1.332
type: bug
status: done
priority: P1
created: 2026-10-24
reporter: jinhu
branch: JinhuW/review-fixes-v1331
pr: 867
version: 1.332.2
related: [RS-365, RS-366, RS-376, RS-378, RS-382, RS-384]
---

## Ask

> /code-review high review the dev to prod change, release it after fix all issues you identified.

## Context

`origin/main...origin/dev` held 42 commits by release time, v1.318.2 →
v1.332.1. A high-effort review found no blocker in the backend: migration
0204, the proxy DEAD tracking, the new coordinator routes and the market trend
fix all hold up. Three PRs landed after the review ran and were read before
release: the PayPal eCheck fix (RS-386, v1.331.1), the Inventory column sort
(RS-387, v1.332.0) and the iOS focus-zoom cap (RS-388, v1.332.1). None needed
a change. The review found ten defects. Most were in the label-printer flow
that RS-371 to RS-384 built:

1. **Review mode Approve** (`DesktopBoxCheck.approve`) cleared `busy` in its
   `finally` before awaiting the box label (RS-378). The PO was already at
   Ready to Pay while the page still showed Reviewing and Approve was
   clickable again. A second click re-ran the zeroing PATCH with
   `expectStage: 'reviewing'`, and the error dialog said the PO had moved.
2. **A label asked for while the printer was *Connecting…*** returned from
   `useLabelPrint.send` without printing anything. Pack mode had already
   marked the product printed, and Review mode went on to leave the page.
3. **The print-dialog fallback** settled only on `afterprint`, after every
   image loaded. A failed draw, or a browser that never fires `afterprint`,
   stalled the shared print queue for the rest of the tab, and Review mode's
   approve never reached `onApproved`.
4. **The bar's 15 s status check** (`labelPrinter.check`) wasn't serialized
   with the print queue. Between labels its `ESC ! ?` write could overlap the
   next job's GATT writes, and Chrome refuses an overlapping write. The two
   checks also shared the single `reply` slot.
5. **The account timeline** marked logins `unreachable` when any one
   worker's ledger read failed, though the other workers had answered. Each
   worker's ledger is capped at its newest 500 rows (the console's maximum),
   so an old stint lost its early logins without a word.
6. **Assign** returned 502 whenever `/v1/fleet` couldn't be read, though it
   wanted only one worker's proxy and the vault write path might be healthy.
7. **The reddit api's watch** logged relay failures through the logger whose
   problem hook feeds `worker_errors`. That queued them for the relay that had
   just failed, and padded the digest after an outage.
8. **The worker page's Accounts used** cached a failed timeline load as
   `'error'` and never fetched it again.
9. **`labelPrinter.open`** added another `characteristicvaluechanged`
   listener on every connect. `reconnect` also retried forever on a printer
   whose failure was `no-port`, which waiting never fixes.
10. **New test comments** cited ticket numbers (`// RS-368:`,
    `// RS-375:`, `// RS-376:`), which the style rules forbid.

## Acceptance criteria

- [x] Review mode's Approve stays busy until the box label is out and the page leaves.
- [x] A label asked for mid-connect goes over Bluetooth once the printer is on, or through the dialog if the connect fails.
- [x] The dialog ends once: on `afterprint`, on leaving print media, or on a draw/image failure with a toast. Labels queued behind it go on.
- [x] Status checks and print jobs reach the printer one at a time. A unit test races a check, a job and a check, and sees no overlapping write.
- [x] Each characteristic gets one answer listener across reconnects. A printer that returns with no known port is forgotten, not retried.
- [x] The timeline says `partial` when some workers failed or a full ledger page starts after the account's first stint there, and `unreachable` only when no worker answered. A holder that isn't a worker id isn't asked.
- [x] Assign goes ahead when the fleet document can't be read. The DEAD check uses the worker's last recorded proxy, and the stint's proxy stays unrecorded.
- [x] The reddit watch's relay failures stay out of `worker_errors`.
- [x] A failed timeline load is fetched again on the next unfold.
- [x] No new comment cites a ticket number.

## Out of scope

- **A per-worker proxy lookup on the console.** The review suggested a narrow
  route, so Assign wouldn't compose the whole fleet document. That is a
  facebook-tracker release plus a homelab deploy, and Assign is a rare manual
  action. Not blocking on an unreadable document fixes the part that hurt.
- **Paging the console's login ledger further back** (a `since` or `before`
  parameter). Also a tracker change. The timeline now says when the ledger
  stops short, which was the silent part.
- **Stopping the watch's remaining posts after one relay failure.** Each post
  still waits out its own 15 s timeout during an outage.

## Notes

- Verified locally: unit and integration suites, plus a Playwright run with a
  fake CT221D. Approve was clicked while the printer was still connecting: the
  button read "…" until one Bluetooth job finished, no writes overlapped, and
  the PO moved once. With no Bluetooth and a stubbed `print()` that never
  fires `afterprint`, the approve finished once print media ended. The Fleet
  worker page ran against a scratch coordinator and console. A forced 502
  showed *could not be loaded*, the next unfold fetched again, and a `partial`
  answer showed its note.
- The four new `labelPrinter` tests fail against the old module.
