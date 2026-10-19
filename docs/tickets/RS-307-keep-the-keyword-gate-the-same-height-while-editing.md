---
id: RS-307
title: Keep the keyword gate the same height while editing
type: bug
status: done
priority: P2
created: 2026-10-18
reporter: jinhu
branch: fix/keyword-gate-steady-height
pr: "#759"
version: 1.289.1
related: [RS-304, RS-306]
---

## Ask

> for this keyword edit. i hope the hight keep consistence.

## Context

The keyword lists on Monitors ▸ Facebook ▸ *From a search to an alert*
(`pages/desktop/FleetRules.tsx`, RS-304 and RS-306) changed height whenever
editing started. Measured locally on the Keyword gate (`server_ram`, 1600 px
wide):

| | card | Include field | Exclude field |
|---|---|---|---|
| read | 500 | 91 | 147 |
| Edit | 532 | 95 | 178 |
| Edit as text | 496 | 89 | 89 |

There were four causes:

- In Edit each chip grew an inline × (16 px plus a gap). The field rewrapped,
  Exclude gained a row, and the chips moved under the pointer.
- The trailing input was taller than "+ Add keyword" and needed a wider slot,
  so the last row could wrap differently.
- `FleetFlow.tsx` rendered only the edited stage while a draft was open. In
  read mode every stage sits in one grid cell so the card is as tall as the
  tallest (RS-265), so Edit snapped the card to the form. With the production
  rules it went 617 → 533 px.
- "Edit as text" swapped in a `rows`-sized textarea with a two-line hint
  under it.

## Acceptance criteria

- [x] On the Keyword gate, the card, Include field and Exclude field have the
  same height in read mode, after Edit, after + Add keyword and in Edit as
  text. After the fix they measured 506 / 98 / 156 px in all three.
- [x] Opening Edit moves no chip. The × appears on hover or keyboard focus as a
  badge on the chip's corner, without covering its label.
- [x] Edit as text shows a textarea exactly as tall as the field it replaced,
  with the syntax hint in the list's hint line.
- [x] Removing chips, adding keywords and saving work as before. Untouched
  rules save byte-for-byte.
- [x] The Fleet cities chips are unchanged, because the new rules are scoped to
  `.ff-rule-well`.

## Out of scope

The other stages' Edit forms keep their own sizes; the AI prompt editor is
legitimately taller. An expression being edited in place may widen its chip
while its input is open. Adding or removing keywords still changes the height,
since that is the content changing.

## Notes

Plan: `~/.claude/plans/quiet-crunching-toucan.md`. A stray 0.7 px came from
the "with your unsaved edits" note on *Try a listing*, set at 11 px inside a
10.5 px label. It now inherits the label's size. The syntax hint was cut to
one line ("One rule per line. Use OR, AND, NOT, ( ) and "quotes".") so it fits
the Include column, and the matching note moved to the textarea's tooltip.
