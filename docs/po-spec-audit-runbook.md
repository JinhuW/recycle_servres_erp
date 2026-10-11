# PO spec audit — runbook

How to check stored line specs against what the parts really are. This
procedure was first run by hand on 2026-10-11 over every RAM line in prod
(2,023 lines, 350 corrected). Since v1.245.0 the **AI review** runs steps 1–6
on each PO automatically when it moves to Reviewing (see
[FEATURES.md](./FEATURES.md) → Review mode). This runbook is for a sweep
across many POs, or for working out why the reviewer said what it did.

The code that does each step:

| Step | Code |
| --- | --- |
| Decode a RAM part number | `decodeRamPart`, `ramPartMismatches`, `ramPartReadingsMatching` in `packages/shared/src/ramPartDecode.ts` |
| Weigh the witnesses into findings | `checkLine` in `apps/backend/src/services/poReviewChecks.ts` |
| Re-read a label, look a PN up on the web | `apps/backend/src/ai/poReview.ts` |
| Queue, run, write findings | `apps/backend/src/services/poAiReview.ts` |

## 1. Pull the lines

Read-only. Narrow the `WHERE` to the sweep: a category, a date range, or the
lots on open sell orders.

```sql
SELECT ol.id, ol.order_id, ol.product_no, ol.category, ol.part_number, ol.brand,
       ol.capacity, ol.generation, ol.type, ol.classification, ol.rank, ol.speed,
       ol.qty, ls.delivery_url AS label_photo, ls.extracted AS label_read
FROM order_lines ol
LEFT JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
WHERE ol.category = 'RAM' AND ol.qty > 0;
```

To limit it to stock that is being sold now:

```sql
  AND EXISTS (SELECT 1 FROM sell_order_lines sol JOIN sell_orders so ON so.id = sol.sell_order_id
              WHERE sol.inventory_id = ol.id AND so.status IN ('Draft','Packing','Shipped'))
```

## 2. Decode each part number

`decodeRamPart(pn)` gives brand, capacity, generation, form, device, rank and
speed from the makers' schemes (Samsung `M3xx/M4xx`, SK Hynix `HMA/HMAA/HMCG/HMT`,
Micron `MTA/MT/MTC`, Crucial `CT`, Kingston `KVR/KSM/KCP/KTx` and its OEM
numbers, G.Skill, Corsair). A field the scheme leaves open is left out, not
guessed. A part number no scheme takes returns null; those go to step 6.

## 3. Diff against the stored fields

`ramPartMismatches(decode, line)` lists the fields the line names that the
part number contradicts. Blank fields are not mismatches; `ramPartFill`
gives what fills them.

## 4. Check the label photo before trusting the decode

The part number is often the misread part, not the spec. Known misreads:

- SK Hynix `HMAA…` read as `HMA8x…` / `HMA4x…` (the 16Gb prefix)
- Micron `PZ` vs `PDZ` (single vs dual rank)
- Micron `-1G6` vs `-1G9`
- letter O for digit 0 (`CPBOQ` → `CPB0Q`, Kingston `.A0OG`)

`ramPartReadingsMatching(pn, line)` lists part numbers one misread away that
agree with every stored spec. If the label agrees with the line and the decode
doesn't, fix the **part number**, not the spec. Label conventions: Samsung DDR4
stacked LRDIMMs print `4DRx4`; DDR3 Hynix LRDIMMs print `4Rx4`.

## 5. Know the storage conventions before flagging

These are how records are kept, not mismatches:

- **DDR3 speed is the PC3 rating**: `12800` means DDR3-1600. `ramFieldsAgree`
  and `ramSpeedMts` treat the two forms as equal. A DDR3 line storing MT/s is
  inconsistent but not wrong.
- **RAM capacity is per module.** Consumer kit part numbers (Corsair
  `CMK…M2`, G.Skill `F4-…D-/Q-`, Kingston `…K2/`) name the kit total; the
  decoder divides by the stick count.

Brief any agent or helper on these first. The 2026-10-11 web pass flagged both
as mismatches until it was told.

## 6. Web-verify what the decoder can't parse

Only for part numbers `decodeRamPart` returns null on, and drives with no label
read. The reviewer uses the `:online` variant of its model with
`partLookupPrompt` (`apps/backend/src/ai/prompts.ts`). Answers are cached in
`part_number_lookups` by canonical part number, so each is paid for once. A
lookup that cites no source URL is discarded.

## 7. Apply the fixes

In a PO's Review mode, use the AI card's **Apply**. It goes through the ordinary
line PATCH and is audited like any edit.

For a bulk sweep with SQL, do it all in one transaction:

- Update the line.
- Write one `order_events` row per changed line: `kind = 'line_edited'`,
  `detail = {lineId, no, partNumber, changes: [{field, from, to}], reason: 'Spec audit <date>: …'}`,
  `actor_id` = the person running it.
- Re-sync the `label` / `sub_label` / `part_number` snapshots on
  `sell_order_lines` of open sell orders (Draft/Packing/Shipped) that name the
  changed lots.

`seed.mjs`-style guards don't apply here. Check twice that `DATABASE_URL` is
the database you mean.

## 8. Spot-check

Open a sample of the changed lots in the UI and compare each one with its label
photo. To list everything a sweep changed:

```sql
SELECT order_id, detail FROM order_events
WHERE kind = 'line_edited' AND detail->>'reason' LIKE 'Spec audit%';
```
