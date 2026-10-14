---
id: RS-253
title: Fix the dev to prod pre-release review findings
type: bug
status: done
priority: P1
created: 2026-10-14
reporter: jinhu
branch: fix/prerelease-review-rs253
pr: 649
version: 1.258.9
related: [RS-252]
---

## Ask

> /code-review max dev to prod. fix all issues and release to prod.

## Context

A max-effort review of `origin/dev` (v1.258.8) against `origin/main` before
the release.  Thirteen of the fifteen findings are regressions introduced by
the RS-252 batches (v1.258.2–v1.258.8), none of which had reached prod; two
(the Payments verdict routes outside the group lock, the queued preference
batch) are gaps those batches set out to close and left open.

| # | Area | Finding |
|---|---|---|
| 1 | Lists | The keyset walker ends only on a strict `nextCursor === null`, so an older backend's `{ items }` reply refetches page 1 and appends it twice. |
| 2 | Ops | The nightly prod→dev sync's marker probe names `public.env_marker` inside a CASE; Postgres resolves it at analyze time, so a dev without the table aborts every run. |
| 3 | Payments | The Refunds tile lost its PO-only filter and nets sell-order refunds (money out) into the PO refund total its list cannot show. |
| 4 | Phone capture | Every camera mount took a shared photo, so a stale one was scanned into the next unrelated line, including a rescan of an existing PO line. |
| 5 | Inventory | The sheet sort ran per 200-row page and the phone concatenates pages, so category→brand→capacity order restarted at each page. |
| 6 | Phone capture | A shared photo was stored raw; anything above ~3.9 MB overflowed sessionStorage and the share silently did nothing. |
| 7 | Phone capture | The share landing stayed in history; Back replayed it and `/submit` wiped the capture in progress. |
| 8 | Dialogs | ErrorDialog kept its own Tab trap outside the shared stack, so a Modal under it pulled focus behind the error. |
| 9 | Dialogs | Focus on a dialog's panel root let the first Shift+Tab escape to the page behind. |
| 10 | Preferences | The signed-out wipe ran on every cold load before auth settled, clearing the cached layout. |
| 11 | Inventory | A failed first page left the loading skeleton on screen indefinitely. |
| 12 | Payments | Mark transfer, unmark transfer and assign judged and wrote outside the group lock, so they could land on a row a concurrent link had just filed. |
| 13 | Preferences | A batch queued behind an in-flight save was reverted on screen by the earlier reply. |
| 14 | Uploads | The declared-vs-detected format gate also refused to shrink staff uploads whose extension lied, turning them into 413s. |
| 15 | Payments | Collapsing or switching an internal-transaction record dropped its unsaved title or note without asking. |

## Acceptance criteria

- [x] A list endpoint reply without `nextCursor` ends the walk after one fetch.
- [x] The sync marker probe succeeds on a database with and without `public.env_marker`.
- [x] A sell-order refund does not change the Refunds tile.
- [x] A shared photo is scanned only by the next new product's camera, never by a rescan of an existing line, and is gone once the capture is cancelled or submitted.
- [x] A shared photo is compressed before it is stored, and a failed store says so.
- [x] Back after a share does not reset an open capture session.
- [x] The phone inventory list is in one category→brand→capacity order across every page.
- [x] Tab inside an ErrorDialog opened over a Modal stays in the ErrorDialog; Shift+Tab right after a Modal opens stays in the Modal.
- [x] A signed-in reload paints from the cached preferences.
- [x] A failed first inventory request shows the empty state, not the skeleton.
- [x] Mark transfer, unmark transfer and assign lock the group and refuse a linked row from inside the transaction.
- [x] A preference reply never reverts a batch still queued behind it.
- [x] An oversized staff upload whose extension names a different allowed image format is shrunk, not refused.
- [x] Collapsing or switching a dirty internal-transaction record asks first.

## Out of scope

Review items that fell below the cut: the sync-vs-Payments deadlock (pre-existing,
occasional), the tracking-claim error regex, the purge claim without a route-side
expiry, `StorageUnavailableError` mapped on two of seven upload paths, a dev-only
re-seed trap, and the cleanup/i18n nits.  The 0178 `NOT VALID` CHECK was ruled
out (zero affected prod rows).

## Notes

Plan: `~/.claude/plans/federated-squishing-token.md`.

- The shared photo is handed to the camera only when no existing line is being
  edited.  A new product's Scan goes through the rescan path with a draft
  attached, so gating on "no rescan draft" would have dropped every share.
- The camera takes the photo from a ref, not a prop: StrictMode runs its
  mount effect twice, and a prop would have scanned the photo twice.
- The staff-upload shrink encodes a mislabelled image into the *declared*
  format, as before RS-252, so the stored type is always one the route's
  allowlist accepted.
- Verified by the suites (frontend 809, backend 2407), the marker probe run
  against a scratch database in all three states, and seven headless-Chrome
  checks on the local stack.
