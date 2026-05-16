# RAM `type`/`generation` split + Gemma 3 OCR — Design

**Date:** 2026-05-16
**Status:** Approved (design)

## Problem

The RAM `type` field currently stores the DDR **generation** (DDR3/DDR4/DDR5).
There is no field capturing the device class (Desktop / Server / Laptop) even
though the AI prompt already reasons about it via the DIMM form factor. We also
want OCR extraction to run on Gemma 3 27B for all categories and to raise the
overall extraction success rate.

## Decisions

- **Approach A — true rename + new column.** Rename `order_lines.type` →
  `generation`; add a fresh `type` column meaning Desktop/Server/Laptop. SQL
  stays semantically honest; matches the requested naming exactly.
- **Model:** global OCR model becomes `google/gemma-3-27b-it` for all
  categories. `OPENROUTER_OCR_MODEL` env override still wins.
- `generation` = DDR generation; `type` = Desktop | Server | Laptop;
  `classification` = DIMM form factor (UDIMM/RDIMM/LRDIMM/SODIMM), unchanged.

## Part 1 — Data model & migration

**Migration `0027_ram_type_generation.sql`:**

```sql
ALTER TABLE order_lines RENAME COLUMN type TO generation;
ALTER TABLE order_lines ADD COLUMN type TEXT;
UPDATE order_lines
SET type = CASE classification
  WHEN 'SODIMM' THEN 'Laptop'
  WHEN 'UDIMM'  THEN 'Desktop'
  WHEN 'RDIMM'  THEN 'Server'
  WHEN 'LRDIMM' THEN 'Server'
END
WHERE category = 'RAM';
```

- **`apps/backend/src/types.ts`:** `OrderLine` gains
  `generation: string | null`; `type` retained with new meaning.
- **Routes** — every `ol.type`/`l.type` reference gains a parallel
  `generation` in SELECT / INSERT column lists / UPDATE COALESCE:
  - `routes/orders.ts` (lines ~13, 137, 174, 250–255, 286, 361, 384–390)
  - `routes/market.ts` (lines ~16, 41)
  - `routes/inventory.ts` (lines ~31, 84, 127, 385, 408)
  - `routes/scan.ts` (RAM field passthrough)

## Part 2 — AI extraction, model & success rate

- **`apps/backend/src/ai/openrouter.ts`:** `DEFAULT_MODEL` →
  `google/gemma-3-27b-it`; `temperature: 0` (was 0.1).
- **`apps/backend/src/ai/prompts.ts`** RAM JSON shape:

  ```json
  {"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"… GB","generation":"DDR2|DDR3|DDR4|DDR5","type":"Desktop|Server|Laptop","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx16|1Rx8|1Rx4|2Rx16|2Rx8|2Rx4|4Rx8|4Rx4|8Rx4","speed":"MT/s number only","partNumber":"…"}
  ```

  - `GENERATION` rule = the current PC-code rule (PC2→DDR2 … PC5→DDR5).
  - `TYPE` rule: SODIMM→Laptop, UDIMM→Desktop, RDIMM/LRDIMM/ECC→Server;
    always emit `type` when `classification` is readable.
- **Success-rate hardening (all categories):**
  - Prompt preamble tightened: "Respond with a single minified JSON object and
    nothing else — no markdown, no code fences, no prose."
  - **One automatic retry:** if `parseModelJson` returns null, re-call once
    with an appended "Your previous reply was not valid JSON. Reply with ONLY
    the JSON object." Today a parse miss throws → 502 → user re-shoots.
- **`apps/backend/src/ai/stub.ts`:** RAM fields gain `generation: 'DDR4'`,
  `type: 'Server'` (RDIMM→Server).
- **`apps/backend/tests/ai.test.ts`:** update RAM expectations for the
  generation/type split; add a retry-on-bad-JSON test.

## Part 3 — Frontend

- **`lib/types.ts`** (3 line shapes ~37, 122, 173): add
  `generation: string | null`; `type` keeps new meaning.
- **`components/PhCategoryFields.tsx`** RAM block: DDR `<select>` rebinds to
  `generation` (label `t('generation')`); new `<select>` for `type` with
  options Desktop/Server/Laptop (label `t('type')`).
- **`pages/desktop/DesktopSubmit.tsx`:** `RAM_TYPES` → generation list bound to
  `generation`; add `RAM_DEVICE_TYPES = ['Desktop','Server','Laptop']`
  `CatSelect` bound to `type`; patch builder splits `generation`/`type`.
- **`aiPatch` / `aiDefaults` / `blankDefaults`** in `SubmitForm.tsx`,
  `desktop/DesktopEditOrder.tsx`, `MobileApp.tsx`, `DesktopSubmit.tsx`: map
  both `generation` and `type`.
- **Label building** (`buildLabel` in `SubmitForm.tsx`,
  `desktop/DesktopDashboard.tsx`, `desktop/DesktopTransfers.tsx`,
  `desktop/DesktopActivityDrawer.tsx`): the DDR token switches from `type` to
  `generation` so short labels stay "Samsung 32GB DDR4". `type`
  (Desktop/Server) is not appended to the short label.
- **`pages/desktop/DesktopInventoryEdit.tsx`, `pages/desktop/DesktopInventory.tsx`,
  `pages/Inventory.tsx`:** add a "Generation" row/column; the existing "Type"
  row now shows Desktop/Server/Laptop.
- **i18n `lib/i18n.tsx`** (en + zh): add `generation` (`'Generation'` /
  `'代数'`); `type` label unchanged (`'Type'` / `'类型'`).

## Out of scope

- No change to `classification`, `rank`, `speed`, or non-RAM categories'
  fields.
- No backfill of `generation` (the renamed column already carries existing DDR
  values).
