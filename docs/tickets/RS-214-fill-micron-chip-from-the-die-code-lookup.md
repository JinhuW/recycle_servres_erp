---
id: RS-214
title: Fill Micron Chip # from the die-code lookup
type: task
status: in-progress
priority: P2
created: 2026-10-09
reporter: jinhu
branch: fix/micron-chip-die-lookup
pr:
version:
related: [RS-209, RS-122]
---

## Ask

> ultrathink is there anyway you can search online and interate all our ram and see if you can find the chip number for them.

## Context

RS-209 (v1.231.0) made a Micron line's Chip # the 3-letter die code (VPP,
TBH…), and backfilled every line whose marking ended in one. That still left
164 live Micron lines, across 124 part numbers, with no die at all: the
field was blank or junk (`1`, `DDR5`, `MICRON`, `NA`, a part number typed
into the wrong field).

A die can be worked out from the module's part number:
- the die revision letter (`-2G6`**`E`**`1`, DDR5 `…48B`**`A`**`1`, Crucial
  `.M8F`**`E`**);
- with density, width and speed bin, that pins the Micron component;
- Micron's FBGA decoder confirms the component's FBGA code.

Jinhu chose to write every looked-up die except the unknowns and the
conflicts, and to correct the misread codes.

The lookup ranks its evidence:
- **observed**: our own sticks of that part number.
- **decoded**: a rule built from our sticks, which reproduces the die for 115
  of 137 held-out observed parts. Every code was checked in Micron's decoder.
- **micron-official**: Micron's decoder and module API alone.

The sheet is [assets/RS-214-micron-die-lookup.csv](assets/RS-214-micron-die-lookup.csv):
part #, specs, FBGA, die, confidence, evidence and whether it was written.
It carries no stock counts.

## Acceptance criteria

- [ ] Migration 0168 writes the looked-up die onto Micron-brand RAM lines
      whose Chip # is blank or not a 3-letter code. That covers 104 part
      numbers, matched on the part number with every non-alphanumeric
      character stripped.
- [ ] A line already holding a 3-letter code (any case or padding), another
      brand, a non-RAM line and a skipped part number are untouched.
- [ ] Six misread codes are corrected to the die their part number decodes
      to: TBG→TBJ, PFX→PFK, RGC→RGV, OBJ→QBJ, MFL→WFL, WDO→WDQ. Micron's
      decoder places each misread on no DDR DIMM (LPDDR4, RLDRAM, or
      nothing). A seventh, D9BPH→D8BPH, is already `BPH` after RS-209.
- [ ] Running it twice changes nothing.
- [ ] Dry-run on dev (prod copy, 2026-10-09): 140 lines change. Every value
      overwritten is junk, a partial read that agrees (`7DB47 DGTGV`→TGV,
      `MICRON S9SRK`→SRK, `1HR75D8PJ`→BPJ), or one of the six misreads.

## Out of scope

- **The 20 skipped part numbers.** They need a person with the stick in hand:
  - **unknown:** `Micron 16GB DDR4-2400T` (a description, likely
    MTA36ASF2G72PZ-2G3B1 → TGL), `Na`, `CRD.MEM.64GB.4800.16GX8.CAMM` (Dell
    CAMM), `BLS16G4D240FSC.16FBD` (Ballistix).
  - **part # and stick disagree:** `MTA16ATF2G64HZ-2G3B1` decodes to TBH,
    but the stick read VHP. `CT16G4DFD824A.M16FE`'s chip text is a Samsung
    part.
  - **several dies seen:**
    - `MTA8ATF1G64AZ-2G6E1` and its typo `MTABATF1G64AZ-2G6E1` (VPP/TBH);
    - `MTA8ATF2G64HZ-3G2E2` (ZFV/CJV/XPF);
    - `MTA8ATF1G64HZ-2G6J1` and `MTA16ATF2G64HZ-3G2J1` (WSM/VPP);
    - `MTC8C1084S1SC56BD1`, also with an ` NF` suffix (DKS/DKT);
    - `MT36KSF2G72PZ-1G6E1` (QBQ/PQL);
    - `MTA18ASF2G72AZ-2G1A1ZI` (SRJ/TBH);
    - `MTA18ASF2G72PZ-2G6D1QG` (TZX/TZV; TZV is an x8 die on an x4 part).
  - **J-revision:** these ship either the J die or E-die VPP, so an inferred
    die isn't one answer: `CT8G4SF832A.8FJ1`, `MTA4ATF51264HZ-3G2J1`,
    `MTA8ATF1G64HZ-3G2J1`, `MTA18ASF2G72PDZ-2G6J1QG`.
- **Wrong ERP specs the lookup turned up** (not touched):
  - `MT36KSF2G72PZ-1G6E1` is DDR3L, but recorded as DDR4.
  - `CT16G4DFD824A.M16FE` is a 2Rx8 desktop UDIMM, not a SODIMM.
  - The rank is wrong on `CT8G4SFS824A.M8FRS`, `CT8G4SF832A.8FJ1`,
    `CT16G4SFRA32A.C8FF`, `CT4G4DFS824A.M8FF` and `CT4G4SFS8266.C8FB`.
  - `BLS16G4D240FSC.16FBD` is dual rank.
- **Typo'd part numbers** (`MTABATF…`, `MTC8C1084S1SC4-BA1`,
  `CT32G4S266M.M16FF` …) are keyed as they are stored, and their part number
  is not corrected.

## Notes

- **A filled die looks the same as one read off a stick once it's written.**
  The sheet is the record of which were inferred and from what.
- **The speed bin matters as well as the die.** The same die has a different
  FBGA code per bin: 8Gb x8 E-die is VPP at 2133–2666 and WFL at 2933–3200;
  8Gb x4 E is VPS / WFK.
- **J-revision modules (`…J1`) often carry E-die VPP.** That's why decoded J
  parts were skipped.
- **Micron's FBGA decoder** is `micron.com/sales-support/design-tools/fbga-parts-decoder`.
  Its JSON backend answers both ways:
  - FBGA → part: `…/_jcr_content.products.json/getpartbyfbgacode/-/-/-/en_US/-/-/<FBGA>`
  - part → FBGA: `…/en_US/-/<PART>/-`
  - The module part-detail API (`…/getproductinfo/-/-/-/en_US/-/<pn>`)
    gives each module's component configuration. It returned data for 38
    Micron base part numbers, and none for DDR5 or Crucial.
- **Mid-RS-209 note from Jinhu:** "The Chip number list here is just popular
  chips number, But not measn all chips must in this list". Any valid die is
  written, not only the price list's.
- **Rollback:** the main checkout's untracked
  `rollback/2026-10-09-micron-chip/restore.sql` restores RS-209's rows. It
  gets this migration's rows, exported read-only from prod, before the
  dev→main release.
