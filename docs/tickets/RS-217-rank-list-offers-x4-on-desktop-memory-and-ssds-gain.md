---
id: RS-217
title: Rank list offers x4 on Desktop memory, and SSDs gain a 3.5in form
type: bug
status: done
priority: P2
created: 2026-10-09
reporter: jinhu
branch: feat/spec-cascade-x4-desktop
pr: 575
version: 1.237.0
related: [RS-210, RS-178]
---

## Ask

> The Cascading Query mapping is not sufficient. For the laptop and desktop do have 2Rx4. SO it is missing here.
>
>
> Pls deep search it and make sure all mapping are correct and avoid any missing!

> pls not only check the existing record, But also all public history.

> DDR3-DDR5 only.

> maybe the prod erp data is wrong. don't trust it. AI may get wrong label data

(Attached: a PO line form with Type = Desktop and Class = UDIMM. The Rank list
offers only 1Rx8, 1Rx16, 1Rx32, 2Rx8, 2Rx16 and 2Rx32.)

Decisions, from a question with three choices:

- x4 ranks: **"Desktop yes, Laptop no"**.
- Form/device pairings (ECC SODIMM as Server, workstation RDIMM as Desktop,
  SODIMM or CAMM as Desktop): **"forget about these special case"**.
- SSD: **"Add 3.5""**.

## Context

RS-210 (v1.233.0) added a rule that hides "server-only" ranks on consumer
memory. It treated every x4 rank, every rank count of four or more, dual-die
and 3DS as server-only. It also applied that one list to UDIMM, SODIMM,
CAMM, Desktop and Laptop alike. The rule came from bus theory ("an unbuffered
bus can't drive x4"), not from what was actually sold.

So a Desktop/UDIMM line couldn't take 2Rx4. The select hid it, a pick or a
label scan cleared it, and the API refused to save it.

The public record for DDR3–DDR5 was checked rank by rank. The prod rows were
not used as evidence, because many of them are scanner misreads. Kingston
`KCP432SS8/16`'s label reads "1Rx8 2G x 64-Bit", and `M393…` and
`MTA18ASF…PZ` RDIMMs were filed as UDIMM. What the record shows:

- **UDIMM 2Rx4 exists.** DDR3 "AMD only" high-density desktop modules, 8 GB
  and 16 GB PC3.
- **UDIMM 4Rx8 exists.** DDR5 4-rank CUDIMMs, which JEDEC now calls CQDIMM.
- **4Rx4, octal, dual-die and 3DS ranks exist only on RDIMM/LRDIMM.**
- **No x4 or quad-rank SODIMM or CAMM was found in any generation.** JEDEC's
  DDR4 and DDR5 SODIMM raw cards are x8/x16 only.
- **3.5" SSDs exist.**
  - HPE LFF SAS SSDs (P10456-B21, P04529-B21) are 2.5" drives in 3.5"
    carriers, sold under 3.5" part numbers.
  - Viking UHC-Silo and Nimbus ExaDrive are native 3.5" drives.
  - The catalog had no 3.5" SSD form.

## Acceptance criteria

- [x] With Desktop or UDIMM, the Rank list offers the full-size ranks the
      line's generation sold: 1Rx4/2Rx4 on DDR3, 4Rx8 on DDR5, none on DDR4,
      and both before a generation is picked. It still hides 4Rx4, 4Rx16,
      8Rx4, 8Rx8, 4DRx4, 8DRx4 and the 3DS ranks.
- [x] With Laptop, SODIMM or CAMM, the Rank list is unchanged: 1–2 ranks of
      x8/x16/x32.
- [x] A DDR3 UDIMM/Desktop line saves with 2Rx4, and a label scan keeps it.
      A DDR4 one is refused with "2Rx4 is a server rank on DDR4". SODIMM +
      2Rx4 is still cleared and refused, with "needs a full-size DIMM".
- [x] SSD form factor offers 3.5" for SATA and SAS, but not for NVMe or U.2.
      Picking SAS still fills 2.5".
- [x] The SSD label scanner can return 3.5" and M.2 2230.
- [x] `3.5"` reaches prod's catalog through a migration that is safe to
      replay.

## Out of scope

- **Form↔device pairings** stay as RS-210 set them, per Jinhu.
- **No backfill of prod lines** whose rank or class is a misread.
- **No new refusals** for combinations simply not found in the public record:
  x16 RDIMM, x32 ranks, DDR5 LRDIMM. "Avoid any missing" rules them out.

## Notes

- **Ranks are gated by generation** (release review of #575). "Desktop yes"
  was answered against DDR3 evidence, and every DDR4 "2Rx4 UDIMM" on record
  is an RDIMM. So x4 fits a UDIMM only on DDR3, and 4Rx8 only on DDR5. A
  blank generation is offered both, and the generation pick re-judges the
  rank.
- **What the gate gives up:** the old rule's catch for an RDIMM filed as
  UDIMM with 2Rx4 now holds on DDR4 and DDR5. On DDR3, or before the
  generation is set, that misread still saves. A part-number prefix check
  (M393/M386, Micron …PZ, Hynix …R7/L7) could catch it later.
- **Why 1Rx4 is offered and 4Rx16 is not:**
  - 1Rx4 is the single-sided member of the same DDR3 x4 high-density family
    as 2Rx4; chip width is what the record shows on DDR3 UDIMMs.
  - x16 quad rank appears on no module at all, buffered or not.
  - Triple rank was only ever a DDR3 RDIMM.
- **Generation is one of the rank rule's fields now.** Editing only the
  generation of a legacy SODIMM + x4 line clears the rank in the form, and
  the API refuses that save.
- Plan: `~/.claude/plans/virtual-leaping-coral.md`.
- Debug note: `docs/debug-notes/2026-10-09-spec-cascade-rank-rule-from-theory.md`.
