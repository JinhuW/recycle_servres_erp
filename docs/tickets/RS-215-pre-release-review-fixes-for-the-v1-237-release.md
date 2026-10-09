---
id: RS-215
title: Pre-release review fixes for the v1.237 release
type: bug
status: done
priority: P1
created: 2026-10-09
reporter: jinhu
branch: fix/prerelease-rs215
pr: "#577"
version: 1.237.1
related: [RS-207, RS-208, RS-209, RS-210, RS-212, RS-213, RS-214, RS-217]
---

## Ask

> wait all workspace work done, then run an code review for all change in the dev, and fix all issue. then release to prod.

## Context

The release takes dev from v1.230.0 (main 1aa77805) through RS-207 to RS-214.
`/code-review high` ran over dev against main and over each PR that landed
while the review was going on. Each finding was checked against the code, and
each one about data was checked read-only against prod before anything was
fixed.

**dev against main (RS-207 to RS-212)** — ten findings:

| # | Finding | Verdict |
|---|---|---|
| 1 | Inventory select-all fetches the rows for lots past the listed products from `POST /api/inventory/rows`, which returned any id it was given. A lot sold, archived or emptied after the list loaded still joined the selection and its export. The page's own comment said such a lot stays out. | **Fixed**: `/rows` returns only lots that are still sellable, on an unarchived PO, with units |
| 3 | The grouped inventory read stopped at the newest 2000 lines. With Show sold on, prod's matching lines already pass that, so the oldest stock fell out of the grouped view and out of select-all, silently. | **Fixed**: the cap is the selection ceiling (5000), and reaching it logs a warning |
| 4 | Select-all held each lot to the warehouse filter but not to the attribute chips, which match a product when *any* of its lots does. A lot typed with another brand, in a product that matched, was selected under a brand chip that excludes it. | **Fixed**: each lot is held to every chip on its own |
| 10b | `/rows` and `/export` each repeated the selection's parse and checks. | **Fixed**: one helper |
| — | A partial transfer's clone was written without `chip_number`, so the lot split off lost its Chip # (pre-existing; Chip # is the die-pricing key since RS-209). | **Fixed**. `serial_number` stays uncopied: a split can't tell whose serials moved |
| 2 | The PO PATCH spec check (RS-210) reads the line before the transaction. | Kept: the route's documented convention for 400-level checks, which the serial and item-type rules share; the worst case is a conflicting line, which the rules already tolerate on lines older than them |
| 5 | Exporting a selection now POSTs, and a backend older than the bundle has no POST route. | Kept: only in the minutes between the Worker and Railway deploys; the error is shown and a retry works |
| 6 | The Micron die-code cut only matches an FBGA code at the end of the marking. | Kept: no prod Micron chip is typed die-code first |
| 7 | An OCR brand of "Micron Technology" isn't treated as Micron. | Cannot happen: the RAM scan prompt limits brand to Samsung, SK Hynix, Micron, Kingston or Other |
| 8 | The phone form's `set` reads the edited keys from the render-time line. | Kept: it only drives the AI-filled styling, and each `set` comes from its own event with a render in between |
| 9 | `SPEC_COLS` in `lib/orderInput.ts` repeats the shared `SPEC_FIELD_TO_DB_COL`. | Kept: the local map is typed by `CascadeField`, so a missing column fails to compile; the shared one is `Record<string, string>` |
| 10a | `sellable_ids` rides on every products response. | Kept: the select-all checkbox's tri-state needs it, and it is about a thousand ids |

**PR #569 (RS-214, migration 0168)** — eight findings, none fixed. 0168 was
already applied on dev, so it can't change. Each finding was checked against
what 0167 + 0168 will do to prod:

- **The six misread fixes ignore part numbers.** After 0167's cut, each of the six codes sits on exactly one prod line, and each fix is the die that line's part number decodes to.
- **A marking with the die code first would be overwritten.** None is typed that way on prod.
- **Parts with more than one plausible die are written.** The J-revision parts are backed by our own stick readings, and the RS-214 CSV records which dies were inferred.
- **The part-number key strips a P/N label differently.** No Micron part number on prod carries one, and both sides of the match strip the same characters.
- **No order event, three-letter junk left, one of six fixes tested, six UPDATEs.** Kept. Data migrations here write no events; no lookup part carries three-letter junk; the migration is immutable now.

**RS-213 (#571, #572, #573).** Each PR was reviewed right after it reached
dev (#571) or before it did, and every fix round was reviewed again. The
findings went to the session that owns RS-213, which fixed them in its own PRs:

- **#572 (stored sell-order #)**
  - A save during the deploy overlap could renumber an order the old instance had rewritten. The # is now healed from the old derivation.
  - The packing list grouped by # alone, folding a re-spec'd lot into another product's row. It now prints one row per # and key, and Pack shows each lot's own part # under its #.
  - A typed line's # carry ignored warehouse and sub-label.
  - Pack's `no ?? i + 1` fallback could collide with a real #. The server now always sends a #.
  - MCP `lineCount` had changed meaning. It is back to lines, with `productCount` added beside it.
  - `append_batch` is still written, so a rollback renumbers nothing.
  - The seed numbered products the backend never would.
  - One fix round grouped Pack by an opaque product id, which split a fold across warehouses. It was reverted before the merge.
- **#571 (stored PO #)**
  - A partial-transfer clone tied with its source in sell-order folding. It now breaks ties on lot id.
  - A dead re-export and unused response fields were removed.
- **#573 ("product" wording)**
  - Unsaved products read "new n" in the # column, the drawer and every message, not a row number nobody can see.
  - The server names an add by its part # (PATCH, which can't know the editor's n) or as "new product n" (create, which sends every row in order).
  - The phone counts products by #.
  - The archive log counts lots.
  - A refusal still said "Lines…", and a one-product submit read "1 products".
- **Kept:**
  - Deploy-overlap windows of seconds: #571's trigger lock order, and #572's renumber of an all-unnumbered order.
  - No trigger check on a supplied #.
  - The boot-time freeze failing fast on an unmigrated database.

**RS-217 (#575)** started while the release was being prepared, so it was
reviewed before it merged. Its first rank table let a full-size UDIMM take x4
and quad ranks in every generation, and it treated triple-rank and 4Rx16 as
consumer ranks. Before the merge, the rule became per-generation: only the
pairings each generation actually sold (DDR3 x4, DDR5 4Rx8) are allowed. 0171's
re-rank was checked against prod's SSD form list, read-only.

The release also carries a test-only fix. The sell-order price-template test
took two seeded lots of any category, and the packing list places a line by its
lot's category, so the by-PO tab test failed most runs that drew a non-RAM lot.
It failed on dev and in PR CI during this release. The test now pins both lots
to RAM.

## Acceptance criteria

- [x] Inventory → Select all, with a brand chip on, selects only lots of that
      brand, also inside a product whose other lots are typed differently.
- [x] A lot sold, archived or emptied after the Inventory list loaded doesn't
      join Select all, or the export of the selection, when it sits past the
      200 listed products.
- [x] With Show sold on, select-all and the grouped view reach every matching
      lot up to 5000 lines, and the backend logs a warning when the cap is hit.
- [x] A partial transfer's new lot keeps the source's Chip #.
- [x] dev is released to main (#579, 46790727), and prod health reports 1.237.1.

## Out of scope

- Unifying the six `l.no ?? i + 1` deploy-skew fallbacks, and the other
  RS-213 cleanups, which stay with RS-213.

## Notes

- Plan: `~/.claude/plans/rosy-stargazing-puppy.md`. The plan review moved two
  test designs that couldn't fail on the old code, tied the read cap to the
  selection ceiling instead of a bare 10000 (which would have made select-all
  413), and dropped finding #9.
- The wait for #577's checks hung for six hours because the PR was born
  conflicting and got no checks. See
  `docs/debug-notes/2026-10-09-pr-check-wait-hangs-on-a-conflicting-pr.md`.
