---
id: RS-224
title: Fix the 2026-10-10 full code-review findings
type: bug
status: done
priority: P1
created: 2026-10-10
reporter: jinhu
branch: fix/code-review-2026-10-10
pr: 593
version: 1.239.2
related: []
---

## Ask

> /code-review max The entire codebase. we pushed a lots of code in the past week. Run an full passthrough code review for the project.
>
> Fan out agents to make sure all code get covered by this code review session.

> yes. go ahead and fix all them. then relese it.

## Context

`/code-review max` ran over the whole codebase on 2026-10-10: the 243 files the
week's 104 commits touched (RS-160 to RS-221) and the 330 nobody touched.  About
108 candidates were verified: 99 confirmed, 8 plausible, 1 refuted.  Fifteen
were reported as most severe, plus a dozen medium ones; "fix all them" covers
those 27 and the smaller items in the same files.  The fixes were split across
seven agents by file, then a separate review of the combined diff found five
regressions, fixed before release.

The three worst were pre-existing and let one request stall or crash the
backend: the public-form email regex (unauthenticated), the OAuth token
endpoint's metric label (unauthenticated) and the market part-number regex
(any login).

## Acceptance criteria

- [x] `POST /api/public/quote` with a 60k-character crafted email returns 400 in
      milliseconds; the same holds for suppliers, customers and members.
- [x] A 64k-character part number on `/api/market/lookup` returns in
      milliseconds; the JS canon pattern matches the SQL one.
- [x] An unknown `grant_type` on `/oauth/token` adds no metrics label; DCR caps
      redirect URIs at 10 × 2048 characters.
- [x] A NUL or lone surrogate in a public form is a 400, not a 500.
- [x] `readSafeNext` refuses `/.//evil.com` and its variants.
- [x] A CR/LF in a coordinator or Access secret doesn't crash the backend; a
      tracker 401 is a 502, not a logout.
- [x] Phone Back/Cancel deletes only a draft that capture created.
- [x] Desktop and phone stage moves send `fromStage`; Approve zeroes lines only
      while the PO is in Reviewing (`expectStage`) and stops on an unsaved count.
- [x] A sell-order editor save is refused (409 `lines_changed`) when its lines
      changed since it loaded them, and not after its own price adjust.
- [x] Reopening a Closed sell order clears pack ticks; a removed line's tick
      goes with it.
- [x] Pack mode's Space and scans stay in the *Packing from* warehouse.
- [x] PO line removal and archive lock lines before checking claims, without a
      new lock-order inversion.
- [x] A purchaser's qty/cost edit on the inventory page sends a submitted PO
      back to Draft; spec edits don't.
- [x] Inbox, bank, warehouse, member, consent and dialog findings listed in
      CHANGELOG 1.239.2 are fixed with tests.

## Out of scope

- The share target on iPhone: routing it is not enough, `ShareTarget.tsx` stores
  the image where nothing reads it.  Follow-up.
- A cleanup job for DCR clients that registered and were never used.
- The inventory edit page doesn't warn a purchaser that a qty/cost save sends a
  submitted PO back to Draft.
- About 50 lower-severity confirmed findings in the review's verdict log.
- VG-C3 (re-tick at 0 answers 409): an existing test asserts it, so it is kept.

## Notes

- Email and part-number fixes cap length before any regex runs; the SQL canon
  pattern is unchanged because an index is built from its exact text.
- `useLineSaveQueue.flush()` now resolves a boolean instead of throwing; a
  refused line clears once the re-read it triggers lands.
- The archive path locks the claiming sell orders before the PO's lines, the
  order a sell-order save takes them in.
