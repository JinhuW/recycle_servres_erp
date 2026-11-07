# WS-B — Seller tasks in the worker

Teach the fleet worker (the vendored `ai-marketplace-monitor` fork) the four
seller kinds. Build against CONTRACTS §4 with a fake ERP; nothing from the
other workstreams needs to be merged.

## Setup

- The fork is gitignored and pinned in `trackers/facebook/VENDOR.md`
  (`recycle-patches` at `9370780` at the time of writing). Clone it into your
  worktree's `trackers/facebook/ai-marketplace-monitor/` from the
  `private-mirror` remote (the clone at
  `~/orca/workspaces/recycle_servres_erp/moonjelly/trackers/facebook/ai-marketplace-monitor`
  has both remotes configured; copy its remote URLs). **Never push to
  `origin`** (upstream). Build both venvs per `trackers/facebook/AGENTS.md`;
  the memory note "ruff fix=true" trap applies: run ruff without `--fix`
  surprises on unrelated files.

## Owns

- In the fork: a new `seller_tasks.py` (or a small package), the dispatch in
  `monitor.py`'s `_run_task`, the report/screenshot calls on the existing
  ERP client, and tests.
- `trackers/facebook/VENDOR.md` (the new pin), `trackers/facebook/rs_worker/`
  if the entrypoint needs anything, `trackers/facebook/CHANGELOG.md` under
  `[Unreleased]`.

## Do

1. **Dispatch first.** In `_run_task`, branch on `kind` before the item
   lookup: seller kinds go to `seller_tasks.run(marketplace, task, client)`;
   everything else is unchanged. Follow `verify_slug_task`'s shape (events,
   navigation, wall check, result).
2. **Port, don't import.** `rs_poster` and `rs_messenger` aren't in the image
   and must not become dependencies. Port from:
   - `rs_poster/rs_poster/poster.py` (composer steps, location guard) and
     `selectors.py` (composer and restriction markers);
   - `rs_messenger/rs_messenger/inbox.py`, `sender.py`, `selectors.py`
     (inbox scrape, composer, bubble check).
   Keep selectors and timings in code (owner, 2026-11-07).
3. **ad-post**: download the photos from the payload URLs to a temp dir,
   compose, publish, then find the new listing's id (the seller's "Your
   listings" page) and report `{ fb_listing_id }`. Not found → `uncertain`
   with the reason. Clean the temp dir always.
4. **ad-delete**: open the listing by id, delete, confirm it's gone.
5. **inbox-sync**: read up to `max_threads` threads and the last
   `max_messages` of each, oldest first, as `InboxThread`. Fix on the way:
   - an unrecognised bubble direction is `unknown`, never `in`;
   - identical consecutive messages stay separate entries;
   - `has_image` for bubbles carrying an image or attachment.
6. **msg-send**: open the thread; compare the tail on the page with the
   payload's `tail` plus `body` — if the body is already the newest outbound
   bubble, report `{ already_sent: true }` without typing. Otherwise type the
   body as **one** message (fix A10-36: newlines become Shift+Enter or are
   joined), send, and confirm a new outbound bubble with that text appeared.
   Not confirmed → `uncertain`; never retry the send.
7. **Walls** after every navigation and every submit (CONTRACTS §4.6). On a
   wall: report `wall`, then let the existing `_wall` path park the worker.
8. **Report before done.** Call `POST /api/fleet/worker/seller/report`, then
   return the task result for `done` (`{ seconds, stopped? }`). A report that
   fails over the network is retried a few times; an `accepted: false` answer
   is logged and ignored.
9. Screenshot on any `failed` step via the screenshot route, best effort.

## Tests

- Fixtures: hand-written HTML for the composer, inbox list, a thread (with
  in, out, unknown, image and repeated bubbles) and the listings page, modelled
  on the selectors you port. They are guesses until F.live refreshes them from
  real pages; say so in the fixture folder's README.
- Unit tests for parsing, alignment-friendly output, the already-sent check,
  the one-message typing, and dispatch (seller kinds never search; search
  unchanged).
- A fake ERP (a tiny HTTP server in the test) that hands each kind and
  records reports.
- `scripts/release.sh --dry-run patch` passes (gates + all suites). **No
  release is cut**; F does that.

## Exit criteria

- [x] Dispatch, the four kinds and the wall checks implemented with tests on fixtures.
- [x] Vendored monitor suite, tracker suites and `release.sh --dry-run` pass.
- [x] Fork commit pushed to `private-mirror` only; `VENDOR.md` pin updated with `scripts/check-vendor.sh update`; the moonjelly clone fast-forwarded if it is clean (otherwise say so in the PR).

  Done 2026-11-07: `recycle-patches` at `d788039` on `private-mirror`; the moonjelly clone was clean and is fast-forwarded to it.
- [x] `[Unreleased]` entry in the tracker CHANGELOG; README Status updated.
