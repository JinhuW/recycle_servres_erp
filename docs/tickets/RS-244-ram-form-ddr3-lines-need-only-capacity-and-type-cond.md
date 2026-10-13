---
id: RS-244
title: RAM form: DDR3 lines need only capacity and type, condition never required
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: feat/ddr3-required-fields
pr: 629
version: 1.253.0
related: [RS-217]
---

## Ask

> update this form.
>
> When Generation is DDR3. Only capacity and type need to fill.
>
> at any time. condition is not required.
>
> (with a screenshot of the desktop PO product drawer, every RAM field and
> Condition starred, the banner reading "Still needed: Brand, Capacity,
> Generation, Type, Class, Rank, Speed (MHz), Part #, Qty, Unit cost")

## Context

Every RAM spec field has been required since v1.29.0 (`lib/ramRequired.ts`,
one rule for the desktop drawer, the PO editor, box check and the phone
form). DDR3 is end-of-life stock that trades by capacity and module form, so
brand, class, rank, speed and part # are busy work there. Part # has a second
gate — Submit refuses a blank one unless a synthetic id can be built — and
inventory groups RAM by it, so a DDR3 line without one gets
`DDR3_<capacity>_<type>` the way a Mixed SSD gets `MIXED_…`.
Condition was never enforced anywhere (prod holds 104 blank ones) — only the
label's `*` claimed it was.

## Acceptance criteria

- [x] With Generation = DDR3, only Capacity and Type carry `*`; the Still-needed
      banner and Confirm accept a line with brand, class, rank, speed, chip #
      and part # blank (desktop drawer, PO editor, phone form).
- [x] A DDR3 line with no part # is submitted as `DDR3_<capacity>_<type>`
      (offered in the existing confirm modal on desktop/phone; applied by the
      API for the PO editor), and inventory shows such lots as one product.
- [x] Any other generation, or none yet, keeps today's rule.
- [x] Condition shows no `*` on any category, in both shells.
- [x] Unit tests cover the DDR3 rule and the synthetic id.

## Out of scope

- A server-side guard for RAM spec fields (none exists for any generation).
- Folding a blank Condition to the DB default.
- What the label scan prefills; the post-scan brand confirmation
  (`ramBrandNeedsConfirm` asks about a brand the AI *claimed*, which is a
  different question from whether brand must be filled).

## Notes

- Rule lives in `ramFieldRequired()`; the labels' `*` and the blockers read it,
  so they can't drift. `isDdr3` lives in shared so the synth rule and the
  form agree on what DDR3 is.
- Box check matches scans by part #, so a `DDR3_…` line is counted by hand.
- Plan: `~/.claude/plans/splendid-jumping-bumblebee.md`.
