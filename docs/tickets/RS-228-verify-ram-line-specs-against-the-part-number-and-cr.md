---
id: RS-228
title: Verify RAM line specs against the part number, and cross-check label scans
type: story
status: done
priority: P2
created: 2026-10-11
reporter: jinhu
branch: feat/ram-pn-decode
pr: "#603"
version: 1.243.0
related: []
---

## Ask

> help me source an database that series number mapping to the ram spec.
>
> for example [Image #1]
> it can mapping back to the samsung 16GB , ect information.
>
> The goal should be the information will double verified when user submit a line of product to see if the series match the info in the form.
>
> It helps to optimize the inform in the form.

> btw, some PN number may have a few character mismatch due to the misreading by the AI. pls take into consideration.

> also think of how to create an validation feature while the ai recognize the image, maybe you can ask the user to capture again or ask user to confirm or we can auto correct the information.

(Image #1: a RAM row reading "Samsung 16GB DDR4 · Server · RDIMM · 1Rx4 · 2400 MHz"
beside the part number `M393A2K40BB1-CRC0Q`, with `M393A2K40` highlighted.)

## Context

A RAM part number encodes most of the stick's spec, but the forms treated it
as an opaque string: Brand, Capacity, Generation, Type, Class, Rank and Speed
were filled one select at a time, by hand or from the label scan, and nothing
compared them with the part number printed on the same label. The
2026-10-11 prod audit found 350 of 2,023 RAM lots whose specs contradicted
their part numbers, and several where the part number itself was the misread
part (SK Hynix `HMAA` read as `HMA8`, Micron `PZ`/`PDZ`, `O` for `0`).

No vendor publishes a PN→spec database we could subscribe to, and an
exact-PN lookup table would only ever know parts already bought. The makers
do publish their part-numbering schemes, so the "database" is a decoder
(`packages/shared/src/ramPartDecode.ts`) for Samsung, SK Hynix, Micron and
Crucial, Kingston (retail and HP OEM), G.Skill and Corsair. Checked against
prod after the audit: 1,744 of 2,023 RAM lines decode, and the decoded fields
disagree with the audited lines only where the line is wrong (12 consumer kits
recorded at kit size, one SO-DIMM kit filed as UDIMM, one DDR3 speed).

## Acceptance criteria

- [x] A RAM line's Part # field shows what the part number decodes to, with the
      module family marked (`M393A2K40`BB1-CRC0Q), on the desktop drawer and
      the phone form.
- [x] Typing or scanning a part # fills the line's blank specs from it; values
      the user picked or the scan read are never overwritten, and the part #
      a line opened with never fills (an untouched line stays clean).
- [x] Where the form contradicts the part #, the readout lists each field
      (form vs part #) with a one-click fix, and Confirm / Add to order asks
      once before saving: use the part #'s specs, or keep as entered.
- [x] A part # one misread character away from a reading that decodes is
      decoded through that reading and says so, with a button to correct it;
      when the form disagrees, readings that would agree with it are offered.
- [x] Every RAM label scan cross-checks its part # against its printed specs:
      a part # whose one-character correction makes them agree is corrected
      automatically; blanks the model skipped are filled from the part #; a
      contradiction neither explains is reported with a Retake button (desk
      camera stays open), and the RAM sheet flags the stick with a re-read.
- [x] `label_scans.extracted` keeps what the model read, not the corrected
      values.

## Out of scope

- A learned exact-PN table from past PO lines (like the chip # map) for OEM
  numbers that carry no spec (Kingston `9995…`, `KKRVFX…`). The decoder
  covers 86% of prod's RAM lines; the rest would need history the audit just
  showed is unreliable.
- A server-side refusal of a line that contradicts its part #: either side can
  be the misread one, so it stays a question, not a block.
- Gating the RAM sheet's auto-save on a contradiction — the sheet flags it and
  offers a re-read; the line drawer asks again on Confirm.

## Notes

- Fields the scheme leaves open are left out, not guessed: an ECC UDIMM's
  device, a DDR4 RDIMM with four x4 ranks (a 3DS stack), SK Hynix dies whose
  code isn't 4/8/A, Samsung DDR3 ranks, Crucial's brand (the catalog has none).
- DDR3 speed is compared by MT/s, so a line stored as PC3 `12800` matches a
  decoded `1600`; a fill writes the PC3 rate, which is how most DDR3 lines are
  stored.
- Consumer kits decode per stick (`F4-3200C16D-32GVK` → 16GB), the convention
  ~30 of 42 prod kit lines follow.
