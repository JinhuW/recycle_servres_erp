---
id: RS-476
title: Fix the 7-day review findings (2026-10-31)
type: bug
status: backlog
priority: P1
created: 2026-10-31
reporter: jinhu
branch: fix/review-findings-2026-10-31
pr:
version:
related: []
---

## Ask

> Review decisions (2026-10-31):
> #1 [Fix now] One badly shaped pool cookie can stop every fleet claim
> #2 [Fix now] One failing withheld alert blocks every alert after it
> #3 [Fix now] Reddit user-sender keeps its GramJS client after losing the hold
> #4 [Fix now] A cross-post is parked as a duplicate of a copy that may never send
> #5 [Fix now] Price sheet: a RAM line with no short code reads 'not-in-sheet'
> #6 [Fix now] Removing a slot leaves its leased tasks stuck
> #7 [Fix now] Every host is told to start workers for the same free slots
> #8 [Fix now] GET /desired rewrites the release row on every poll during a roll
> #9 [Fix now] Search budget day is UTC while the funnel day is Eastern
> #10 [Fix now] Home loads draft blockers one draft at a time

## Context

These come from a `/code-review` of the last 7 days of `dev`
(`8b9cec1b..eaf187f7`, 171 commits). The owner chose "Fix now" for every
finding on the decision page.

1. `storageStateFromText` (`fleet/claim.ts`) threw on a pool cookie stored as
   JSON without `origins`, for example the keyed-object form `cookieUid`
   accepts. It did so inside the claim transaction. Free slots are picked by
   `account_no`, so every new worker hit the same account and no claim
   anywhere could succeed.
2. `fleet-alert-sender.py` aborted the whole pass on any exception. Reports are
   retried first and alerts are sent oldest first, so one entry that kept
   failing blocked every withheld alert behind it.
3. A Reddit api that lost the user-sender hold stayed connected and kept the
   `reads` loop calling Telegram. The same session used from two IPs gets
   revoked, which breaks invariant 8.
4. A later cross-post was parked, and parking is final, as a duplicate of an
   earlier copy that was still only `target`. If that copy's send failed, the
   lead was lost.
5. On a sheet with a Short code column, a Micron line with no chip marking
   (short code null) matched no row.
6. `POST /slots/:no/remove` copied part of `dropSlot` by hand. The pool trigger
   already released the leased tasks, so this was cleanup, not a live bug.
7. `workerCount` added every free slot in the fleet to each authoritative
   host's count.
8. `advanceRoll` rewrote the release row on every agent poll during a roll.
9. `minutesTodaySql` and the `fleet_minutes` view counted UTC days, while the
   Analysis funnel has used Eastern days since RS-473.
10. Home awaited `leaveDraftBlockers` one draft at a time.

## Acceptance criteria

- [x] A claim succeeds for a pool cookie that is a keyed JSON object, or
  `{cookies:[…]}` with no `origins`. Only a worker-saved state that has
  `origins` and is invalid still throws.
- [x] One withheld alert or report that keeps failing no longer stops the next
  one. An entry is parked after 5 failures, or at once on a Telegram 400. The
  message is cut to fit 4096 characters, and its link is kept.
- [x] A Reddit api that loses the hold disconnects its user client. After
  that, neither the user-notify loop nor the reads loop touches it.
- [x] A cross-post whose earlier copy is unsent waits 30 s and is not parked.
  It is parked once that copy is notified, and alerted itself if that copy
  fails.
- [x] A RAM line with an unknown short code falls back to all of its part's
  rows: it reads matched or conflict, never not-in-sheet.
- [x] Slot remove goes through `dropSlot`.
- [x] The free slots are shared out among the live authoritative hosts: with
  two hosts and three free slots, the counts are 2 + 1.
- [x] `advanceRoll` writes the release row only when the roll changed.
- [x] The budget day, both `minutesTodaySql` and `fleet_minutes` (migration
  0218), is an Eastern day.
- [x] Home loads draft blockers through `allLimited`.

## Out of scope

- Deploying the reddit tracker (Railway and OCI), copying the sender script
  to the homelab VM, and releasing `dev` to `main`. Each waits for the owner.
- Restarting any Facebook worker. Nothing here needs one.
- A deeper multi-agent review of the same range. The owner was offered one
  and did not take it up.

## Notes

- Sender: only a Telegram 400 parks an entry at once. A 401, 403 or 404 means
  the bot token or chat is broken for every alert, so those still fail the
  whole pass. Parking on them would throw away the backlog. Outages with no
  HTTP answer are not counted either.
- The fixes for 2–4 are in the trackers, which have no CI here. Their own
  suites were run locally: reddit 281/281, sender 14/14.
