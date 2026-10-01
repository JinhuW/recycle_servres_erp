---
id: RS-127
title: Pre-release review fixes for box check and packing list
type: bug
status: done
priority: P1
created: 2026-09-30
reporter: jinhu
branch: fix/release-review-v1189
pr: "#433"
version: 1.189.1
related: [RS-124, RS-125, RS-126]
---

## Ask

> /code-review max from dev to main, release it after fixing all issues.

## Context

The review of `origin/main..origin/dev` (v1.188.0 Box check, v1.188.1, v1.189.0
packing list by PO) returned 15 confirmed findings.  The serious ones:
- The box check reused the cached PO, so Back plus a stage Save reverted
  confirmed line edits.
- A tick survived a later qty change.
- Actions taken before the saved checks loaded erased short counts and flags.
- Pending writes were dropped on exit.
- A keyboard-wedge scan landing on the page ran as shortcuts.
- Send re-notified the purchaser with every flag each time.
- The warehouse-narrowed packing list left out lots that had moved.

## Acceptance criteria

- [x] Entering or leaving `/purchase-orders/<id>/check` refetches the order; a
      dirty PO page refuses to open Check box; the button follows the
      effective role and a non-manager bounce replaces history.
- [x] A tick only counts while counted ≥ the line's current qty; writes clamp
      counted to qty.
- [x] Nothing writes until the saved checks loaded; a failed load shows Retry.
- [x] Pending writes go out on exit; Send/Approve wait for in-flight writes
      and abort if one failed.
- [x] A scan typed onto the page lands in the scan box, not the shortcuts;
      Space acts on the selected row; Escape under a dialog closes only it.
- [x] Scans prefer open lines, refuse to guess between distinct part numbers,
      and a re-scan of a checked line reads "already checked".
- [x] Send sends only flags and extras not yet sent, and shows what was sent.
- [x] Packing lists place a line by its lot's current warehouse.

## Out of scope

`/advance` has no from-stage precondition; a 0 count prefills as short (a
product call); Checked-group order after reload; the legacy `checked ??`
server fallback; the frozen "Counted n of m" note; duplication clean-ups.

## Notes

Plan: `~/.claude/plans/composed-cuddling-lighthouse.md`.
