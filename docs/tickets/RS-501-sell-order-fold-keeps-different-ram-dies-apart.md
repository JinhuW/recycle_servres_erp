---
id: RS-501
title: Sell order fold keeps different RAM dies apart
type: bug
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/sell-fold-by-die
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1054
version: 1.405.1
related: [RS-499]
---

## Ask

> It should not group as it is different part of catagory

(Screenshot: `HMAA2GU6AJR8N-XN` and `HMAA2GU6CJR8N-XN` folded into one row `#167–168`.)

Asked whether the same rule should cover every brand, given that Samsung CB1 vs EB1 had been folded in RS-499, the owner picked "Die splits": fold only when the short code matches (series and die the same); speed can differ. Then:

> This is just an example. Some other part has the similiar issue

## Context

RS-499 (v1.404.0) folded sell-order lines, and gave them one #, by a RAM
series cut at the module organisation (`ramSeries` in
`packages/shared/src/ramFamily.ts`): Samsung `M471A1K43`, SK Hynix `HMAA2GU6`.
That put different dies in one row: SK Hynix A-die (`AJR`) and C-die (`CJR`), and
Samsung `CB1` and `EB1`. A buyer prices a die as its own product.

## Acceptance criteria

- [x] The series runs through the die, the part the short code names: Samsung
  `M471A1K43CB1`, SK Hynix `HMAA2GU6AJR`, Micron module code plus its die
  revision (`MTA36ASF2G72PZ-A2`). Speed still folds.
- [x] `HMAA2GU6AJR8N-XN` and `HMAA2GU6CJR8N-XN` show as two rows and, on a
  line numbered from now on, take two #s. `M471A1K43CB1-CRC` and `…CB1-CTD`
  still fold.
- [x] Stored #s don't change. An order numbered under v1.404.0 keeps its shared
  # but shows the dies as separate rows.

## Out of scope

Renumbering lines that v1.404.0 already gave one shared #.
