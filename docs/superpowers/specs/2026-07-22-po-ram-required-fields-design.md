# PO submit form — required RAM fields

**Date:** 2026-07-22
**Status:** Approved

## Goal

A RAM purchase-order line cannot be saved, confirmed, or submitted while any
of these nine fields is empty:

Brand · Capacity · Generation · Type · Class · Rank · Speed · Chip # · Part Number

When the user tries, the form blocks the action and names the exact missing
fields so they know what to fill.

## Scope

- **In:** the desktop new-PO form (`DesktopSubmit` + `LineDrawer`) and the
  mobile submit form (`SubmitForm` + `PhCategoryFields`). RAM lines only.
- **Out:** SSD / HDD / Other lines (keep today's rules, including the
  Mixed-SSD part-number auto-generate confirm sheet), the desktop
  Edit Order modal, and any backend/API validation.

Part # note: `synthesizePartNumber` has no RAM rule, so for RAM lines a blank
part number is a hard stop — the auto-generate sheet never applies. SSD keeps
its auto-generate flow untouched.

## Design

### Shared helper — `apps/frontend/src/lib/ramRequired.ts`

`missingRamFields(line)` takes any object with the nine keys as optional
`string | null` values (covers desktop `Line` and mobile `DraftLine`) and
returns the i18n label keys of the empty ones, in display order:
`brand, capacity, generation, type, klass, rank, speedMhz, chipNumber,
partNumber`. Empty = null/undefined/whitespace-only. Pure helper → gets a
vitest file (`ramRequired.test.ts`).

### Desktop — `DesktopSubmit.tsx`, `submit/LineFields.tsx`

- `lineReady()` also requires `missingRamFields(l).length === 0` for RAM
  lines. That flows into `canSubmit`, disabling Submit Order.
- `submitDisabledReason` names the missing fields for the first incomplete
  RAM line ("Line 2 is missing: Type, Rank, Chip #") instead of the generic
  "complete line N" hint; non-RAM lines keep the generic hint.
- `handleConfirmLine` (drawer "Confirm line") surfaces the same
  missing-field message via the existing error banner, replacing the
  hard-coded English string with i18n.
- `RamFields`: the seven unmarked labels (Generation, Type, Class, Rank,
  Speed, Chip #, Part Number) get the red `*` required marker.

### Mobile — `SubmitForm.tsx`, `PhCategoryFields.tsx`

- `attemptSave()`: for RAM, if `missingRamFields` is non-empty, show an
  error toast "Please fill in: Brand, Speed (MHz), …" and stop. The existing
  part-number branch below is unchanged (still serves SSD/HDD/Other).
- `PhCategoryFields` RAM: same red `*` markers on the seven unmarked fields.

### i18n — `lib/i18n.tsx`

New keys (en + zh): a "please fill in: {fields}" message for the mobile
toast, and a "line {n} is missing: {fields}" message for the desktop
disabled-reason / confirm-line error. Field names reuse the existing label
keys, joined with "、" in zh and ", " in en via the current interpolation
helper.

## Testing

- `ramRequired.test.ts` — empty/whitespace/populated permutations, order of
  returned keys.
- Manual: desktop submit + drawer confirm + mobile add-item smoke via dev
  server.
