---
id: RS-341
title: Fix the dev-to-main review findings before the v1.310 release
type: bug
status: backlog
priority: P1
created: 2026-10-21
reporter: jinhu
branch: code-review-dev-to
pr:
version:
related: []
---

## Ask

> /code-review xhigh dev to main, fix all issues and release to prod.

## Context

An xhigh review of everything on `dev` but not on `main` (v1.291.1 → v1.309.0,
67 commits, plus facebook-tracker 0.12.x → 0.13.11) reported 15 findings. This
ticket fixes all of them before the release. PR #812 (Accounting, RS-340,
v1.310.0) reached `dev` while the fixes were being made. It got its own review
before the release went out.

Facebook tracker (ships as facebook-tracker 0.13.12):

- **Messenger duplicate replies** (`rs_messenger/sender.py`). The coordinator
  re-queues a non-permanent send failure up to three times. `ERR_NOT_VISIBLE`
  was retryable, but Messenger can post a reply the check doesn't recognise
  (emoji or link rewriting, a moved "You sent" label). `already_sent()` reads
  the pane the same way, so a seller could get the same reply three times.
- **Leftover draft** (same file). After `ERR_NOT_SUBMITTED_UNCLEARED` the
  retry typed into the leftover draft, so the seller got both texts as one
  message.
- **Blind baseline** (same file). `_snapshot` returned `[]` on an evaluate
  error or a pane still loading. An older identical bubble then counted as the
  new reply, and the row was acked `sent` although nothing was sent.
- **Alert-claims seed** (`rs_coordinator/db.py`). It re-aggregated every
  `alert_messages` row on every boot, a table that is never pruned.

ERP:

- **Pool import, positional** (`lib/facebookPool.ts`). Column 8, after the
  cookie, became the token, so supplier rows in the older layout put their
  note into the token.
- **Pool import, header-mapped.** Two headers naming one field overwrote each
  other without a warning (账号,密码,邮箱,密码 stored the mailbox password as
  the Facebook one). Each row also chose its own delimiter, so a quoted CSV
  cell holding `|` split the row.
- **Pool edit** (`routes/facebookPool.ts`). `PUT /:no` erased the stored
  token when a client (a pre-release bundle) sent no `token` field.
- **Reddit live model** (`DesktopTracker.tsx`, `TrackerPrompts.tsx`). Any id
  of the right shape could be saved, including a model without strict JSON
  output, which makes every evaluation fail.
- **0189 backfill.** It named the screenshot uploader as payer on orders whose
  commission a live bank row pays, which the upload route deliberately leaves
  empty.
- **Activity filter** (`packages/shared/src/activity.ts`). The sell-order
  kinds `attachment_added` / `attachment_removed` were labelled "Edited".
- **Review-mode price** (`lib/reviewPricing.ts`). `12,50` was read as 1250.
- **Box Check price field.** A line priced 0 showed `0.00`, which hid the
  market ghost, and Enter couldn't take it.
- **`/api/ai/models`.** A 502 carried `private, max-age=60`, so the browser
  answered the user's retry with the cached failure.
- **Price-sheet precheck.** Its comment named a file that no longer exists.

## Acceptance criteria

- [x] A messenger send whose bubble isn't recognised is marked failed at once,
      never retried.
- [x] A leftover draft is cleared before typing. One that won't clear is
      never typed onto (`ERR_DRAFT_STUCK`, retryable, nothing sent).
- [x] An unreadable pane, or one with no message yet, sends nothing
      (`ERR_PANE_UNREAD`, retryable).
- [x] The alert-claims seed does its work only while `alert_claims` is empty.
- [x] `uid|pw|totp|email|mailpw|rec|cookie|Aged 2y` imports with `note: Aged
      2y` and no token. An `EAA…` value or an empty column 8 still reads as the
      token slot.
- [x] `账号,密码,邮箱,密码` maps the second 密码 to the e-mail password. Any
      other repeated column refuses the rows that fill it
      (`fpRepeatedColumn`).
- [x] With a header row, every row splits on the header's delimiter.
- [x] `PUT /api/facebook-pool/:no` without `token` keeps the stored token, and
      `token: ""` clears it.
- [x] The live-model and trial-model dialogs save only an id the catalogue
      lists as an evaluator model. While the catalogue loads or is down,
      saving is off.
- [x] Migration 0192 clears a 0189-backfilled payer where a live commission
      bank row stands and nobody has changed Paid by since, and writes a
      backfilled Activity line. 0189 itself is unchanged.
- [x] Sell-order file events filter as Added / Removed.
- [x] `12,50` and `1,25` are refused. `1,250.46` and `12,500` still parse.
- [x] A line priced 0 shows the market ghost, and Enter takes it.
- [x] `/api/ai/models` sets `Cache-Control` only on a 2xx.
- [x] The precheck comment names `services/priceSheet.ts`, and the precheck
      drops `Ext.` price headers as the backend does.

## Out of scope

- `provider.require_parameters` in the Reddit tracker's OpenRouter request.
  It would make routing stricter, but it is a tracker deploy (Railway + OCI
  fleet). The ERP-side gate is what stops the bad save.
- Interpreting a decimal comma as a decimal point. `1,250` is ambiguous, so a
  comma that isn't a thousands group is refused.

## Notes

- The ERP rule is never to edit a deployed migration, and 0189 ran on dev. So
  the backfill fix is a new migration (0192; #812 took 0191). On prod, 0189
  and 0192 run in the same boot. `order_events` is append-only, so 0192 adds a
  reverting backfilled event instead of deleting 0189's.
