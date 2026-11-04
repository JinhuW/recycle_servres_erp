---
id: RS-524
title: Show the reason for RMB Flow red alerts on the row
type: story
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/amberjack
pr: 1083
version: 1.416.1
related: []
---

## Ask

> In the rmb flow, pls also note the rason for the red alerts
>
> [Image: book rows AC-1087, AC-1078, AC-1077 with a red ! beside the Order amount]

## Context

The desktop RMB Flow book puts a red `!` in the Order amount column when the
book's total for a record is more than 2% off the record's own figure
(`recordMismatch` in `packages/shared/src/accounting.ts`, since v1.406.0). The
reason lived only in the icon's hover tooltip, so it could not be read while
scanning the book, and each alert had to be hovered separately.

The list API (`GET /api/accounting/entries`) already sends `mismatch` on each
row, and `acctMismatchHint` already words the reason in both languages, so this
is a frontend-only change.

## Acceptance criteria

- [x] A flagged row prints the reason under its Order amount, without hovering:
      `Book ¥73,138.00 vs order ¥X (+Y%)`, with the actual figures.
- [x] The reason is red, in the same small sub-line style as the
      `$1,452.00 @ 6.65` line.
- [x] Rows within 2%, and rows with no record figure, look exactly as they did.
- [x] The line reads correctly in English and Chinese.
- [x] The book stays readable at a normal desktop width, with no clipped text.

## Out of scope

- The phone book. Its rows show no Order amount or alert today, so this would
  be a new feature there.
- The entry drawer.
- The 2% rule itself, and the form's existing warning.

## Notes

The reason is the wording the tooltip already used, so the tooltip is gone. The
line wraps to two lines at a minimum width, because on one line it pushed
Balance off a 1280px screen. The book already scrolled sideways at that width;
the line adds about 75px to that (1017px to 1092px of 990px).
