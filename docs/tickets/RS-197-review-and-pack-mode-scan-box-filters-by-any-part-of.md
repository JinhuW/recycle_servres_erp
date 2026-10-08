---
id: RS-197
title: Review and Pack mode scan box filters by any part of a part number
type: story
status: in-progress
priority: P2
created: 2026-10-08
reporter: jinhu
branch: feat/scan-box-part-filter
pr:
version:
related: [RS-124, RS-187]
---

## Ask

> The PO review mode search should allow part string search instead of exact search.

Clarified in the session: the box should **filter the list as you type**, and
the change applies to **both Review mode and Pack mode** (they share one
matcher).

## Context

Review mode (`#/purchase-orders/<id>/check`, v1.188.0) and Pack mode
(`#/sell-orders/<id>/pack`, v1.218.0) each have a scan box built for a label
scanner. It acts only on Enter, through `matchScan` in `lib/boxCheck.ts`.
That function accepts an exact canonical part number, a prefix of 6 or more
characters, or an exact recorded serial. A manager who types what they can
read off a stick, such as `4K40` for `M393A4K40DB3-CWE` or `HMA84`, gets *"… is
not on PO-n"*.

## Acceptance criteria

- [ ] Typing in either scan box narrows the list to the lines whose part number
      contains the text, at any position and length, ignoring separators and
      case. A label that extends a line's part number, or a serial recorded on
      the line, also keeps that line.
- [ ] Enter ticks (Review) or packs (Pack) the line when the text names one
      part number. The exact part number, the 6+ prefix and the serial still
      come first, so a scanner behaves exactly as before.
- [ ] When the text fits several part numbers, Enter ticks nothing. The text and
      the filtered list stay up, the box blurs, and the message names the parts
      (first five, then "+n more").
- [ ] A scanner's burst does not flash a filter: the filter is debounced and
      the matcher is not.
- [ ] Escape in the box clears its text before it blurs. Escape on the page
      with a filter up clears the filter and does not leave the page. A ×
      button clears it too.
- [ ] Counts, progress, Approve, Mark shipped and Finish review never see the
      filter. *Check all remaining* is disabled while a filter is up.
- [ ] Pack mode's filter searches the whole order (packable lines only), as
      Enter does, even with a warehouse picked.

## Out of scope

- Substring search on serial numbers. Serials still match exactly.
- Making *Check all remaining* act on the filtered rows only. It is disabled
  while filtering instead.
- The phone shell. Neither page exists there.

## Notes

- Plan: `~/.claude/plans/wise-soaring-cake.md`, reviewed by a Plan subagent.
  The review added the debounce, the Escape guard inside the existing
  `useEscapeKey` handler, blurring on an ambiguous result (so the next scan
  replaces the text rather than appending to it), and Pack mode searching the
  whole order.
- `packScan` used to re-derive "was this a part-number hit" from prefix rules
  (`partMatches`). A fragment hit would have failed that test and packed one of
  several lots on a guess, so it now asks whether the scan spells the hit's
  serial instead.
