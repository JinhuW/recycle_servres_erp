---
id: RS-574
title: Fold same-series RAM on a sell order regardless of condition
type: story
status: done
priority: P2
created: 2026-11-08
reporter: jinhu
branch: JinhuW/goldeye-3
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1176
version: 1.449.0
related: []
---

## Ask

> debug the issue that these two part should combined, why it didn't combbined in the SO-4100

> ok. let we ignore the condition for group.

## Context

On SO-4100, SK Hynix `HMA84GR7AFR4N-VK` lots #10 and #28 (Pulled — Tested)
folded into one row, but #11 from PO-1503 (Used) stayed apart. Module family,
label, rank and short code all match; only the condition differed.
`sellSeriesKey` (`packages/shared/src/ramFamily.ts`) put condition into the
series key since RS-499 (v1.404.0), and that one key drives both the table's
fold (`apps/frontend/src/lib/sellOrderLineGroups.ts`) and the # a new lot takes
(`numKey` in `apps/backend/src/services/sellOrderNumbers.ts`).

## Acceptance criteria

- [x] `sellSeriesKey` no longer reads condition: two lots that differ only in condition get the same key.
- [x] The order table folds them into one row (SO-4100: #10, #11 and #28 become one fold).
- [x] A new lot of a series already on the order joins that series' # whatever its condition.
- [x] A fold whose lots have mixed conditions shows every condition in its meta line (`Pulled — Tested / Used`); each member row still shows its own.
- [x] The packing-list row key (part | label | condition) is unchanged, so the packer still sees each condition as its own row under the shared #.

## Out of scope

- Renumbering stored #s: #11 stays #11, and the fold header reads `#10–11, 28`.
- Non-series products (non-RAM, or RAM no family scheme reads) keep condition in their product key, and the bid key is untouched.
