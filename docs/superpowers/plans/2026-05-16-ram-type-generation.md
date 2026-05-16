# RAM type/generation split + Gemma 3 OCR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the RAM `type` field (DDR generation) to `generation`, add a new `type` field holding Desktop/Server/Laptop, switch OCR to Gemma 3 27B, and harden extraction success rate.

**Architecture:** Postgres column rename + new column with backfill from `classification`; backend route SQL gains a parallel `generation` everywhere `type` is read/written; AI prompt emits both keys; one automatic JSON-retry added; frontend forms/labels/views split the two fields.

**Tech Stack:** Cloudflare Workers + Hono + `postgres` (Postgres), Vitest; React + Vite + TypeScript frontend; OpenRouter vision OCR.

**Scope deviations from spec (intentional):**
- `ref_prices` / `routes/market.ts` are **NOT** touched. `ref_prices` is a separate reference-catalog table with its own `type` column and no `generation`; renaming it is out of scope and the 0027 migration only covers `order_lines`. The market page keeps showing `ref_prices.type` as-is.
- `routes/scan.ts` needs **no change** — it persists the model's `result.fields` as an opaque JSON blob (`extracted`), so the new `generation`/`type` keys flow through untouched.

**Commands (run from repo root):**
- Backend tests: `npm --prefix apps/backend test`
- Backend typecheck: `npm --prefix apps/backend run typecheck`
- Frontend typecheck: `npm --prefix apps/frontend run typecheck`
- Migrate dev DB: `npm --prefix apps/backend run db:migrate`

---

### Task 1: Migration — rename `type` → `generation`, add new `type`

**Files:**
- Create: `apps/backend/migrations/0027_ram_type_generation.sql`

- [ ] **Step 1: Write the migration**

```sql
-- The RAM `type` column historically stored the DDR generation
-- (DDR3/DDR4/DDR5). Rename it to `generation` and introduce a fresh `type`
-- column that stores the device class (Desktop / Server / Laptop). Backfill
-- the new `type` for existing RAM rows from the DIMM form factor. Idempotent
-- where Postgres allows.

ALTER TABLE order_lines RENAME COLUMN type TO generation;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS type TEXT;

UPDATE order_lines
SET type = CASE classification
  WHEN 'SODIMM' THEN 'Laptop'
  WHEN 'UDIMM'  THEN 'Desktop'
  WHEN 'RDIMM'  THEN 'Server'
  WHEN 'LRDIMM' THEN 'Server'
END
WHERE category = 'RAM' AND type IS NULL;
```

- [ ] **Step 2: Run the migration**

Run: `npm --prefix apps/backend run db:migrate`
Expected: applies `0027_ram_type_generation.sql` with no error.

- [ ] **Step 3: Verify schema**

Run: `npm --prefix apps/backend run db:migrate` (second run is a no-op)
Expected: no error, `0027` reported as already applied.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0027_ram_type_generation.sql
git commit -m "feat(db): rename order_lines.type to generation, add device type"
```

---

### Task 2: Backend `OrderLine` type

**Files:**
- Modify: `apps/backend/src/types.ts:50`

- [ ] **Step 1: Add `generation` next to `type`**

Change line 50 from:

```ts
  type: string | null;
```

to:

```ts
  generation: string | null;
  type: string | null;
```

(`generation` = DDR gen; `type` now = Desktop/Server/Laptop.)

- [ ] **Step 2: Typecheck**

Run: `npm --prefix apps/backend run typecheck`
Expected: FAILS — route files reference `l.generation` not yet selected. This confirms the next tasks are needed; do not fix here.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/types.ts
git commit -m "feat(types): add OrderLine.generation"
```

---

### Task 3: `routes/orders.ts` — generation in all SQL + mapping

**Files:**
- Modify: `apps/backend/src/routes/orders.ts` (lines ~13, 137, 174, 250–255, 286, 361, 384–390)

- [ ] **Step 1: `LineInput` type (~line 13)**

After `type?: string | null;` add:

```ts
  generation?: string | null;
```

- [ ] **Step 2: `LineFields` type (~line 286)**

After its `type?: string | null;` add:

```ts
  generation?: string | null;
```

- [ ] **Step 3: GET order SELECT (~line 137)**

Change `ol.capacity, ol.type, ol.classification,` to:

```sql
ol.capacity, ol.generation, ol.type, ol.classification,
```

- [ ] **Step 4: GET order response mapping (~line 174)**

Change the `type: l.type,` line to:

```ts
        generation: l.generation,
        type: l.type,
```

- [ ] **Step 5: Create-order INSERT (~lines 250–255)**

In the column list change `capacity, type, classification,` to `capacity, generation, type, classification,` and in the VALUES change `${l.capacity ?? null}, ${l.type ?? null},` to:

```sql
${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
```

- [ ] **Step 6: Patch UPDATE COALESCE block (~line 361)**

After the `type = COALESCE(${l.type ?? null}, type),` line add:

```sql
              generation     = COALESCE(${l.generation ?? null}, generation),
```

- [ ] **Step 7: addLines INSERT (~lines 384–390)**

Apply the same column-list (`capacity, generation, type, classification,`) and VALUES (`${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},`) edit as Step 5.

- [ ] **Step 8: Typecheck**

Run: `npm --prefix apps/backend run typecheck`
Expected: orders.ts no longer the source of errors (inventory.ts may still error — fixed next task).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/routes/orders.ts
git commit -m "feat(orders): persist and return RAM generation"
```

---

### Task 4: `routes/inventory.ts` — generation in all SQL + mapping

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (lines ~31, 84, 127, 385, 408, 467, 474, + response mappings)

- [ ] **Step 1: Inventory list SELECT (~line 31)**

Change `l.brand, l.capacity, l.type, l.classification,` to:

```sql
l.brand, l.capacity, l.generation, l.type, l.classification,
```

- [ ] **Step 2: Activity-events SELECT (~line 84)**

Change `l.brand, l.capacity, l.type,` to:

```sql
l.brand, l.capacity, l.generation, l.type,
```

- [ ] **Step 3: Transfers SELECT (~line 127)**

Change `l.brand, l.capacity, l.type, l.classification,` to:

```sql
l.brand, l.capacity, l.generation, l.type, l.classification,
```

- [ ] **Step 4: `SourceRow` type (~line 385)**

After `type: string | null;` add:

```ts
    generation: string | null;
```

- [ ] **Step 5: Receive sources SELECT (~line 408)**

Change `l.brand, l.capacity, l.type, l.classification,` to:

```sql
l.brand, l.capacity, l.generation, l.type, l.classification,
```

- [ ] **Step 6: Receive re-INSERT (~lines 467, 474)**

In the column list change `capacity, type, classification,` to `capacity, generation, type, classification,`; in VALUES change `${s.capacity}, ${s.type},` to:

```sql
${s.capacity}, ${s.generation}, ${s.type},
```

- [ ] **Step 7: Response mappings**

For every object literal in this file that returns `type: <row>.type` (inventory list, activity, transfers responses), add a sibling `generation: <row>.generation,` line immediately before it. Use:

Run: `grep -n "type: .*\.type" apps/backend/src/routes/inventory.ts`
For each hit, add the matching `generation:` line above it.

- [ ] **Step 8: Typecheck**

Run: `npm --prefix apps/backend run typecheck`
Expected: PASS (0 errors).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/routes/inventory.ts
git commit -m "feat(inventory): carry RAM generation through list/transfers/receive"
```

---

### Task 5: AI prompt — generation/type split + JSON-only preamble

**Files:**
- Modify: `apps/backend/src/ai/prompts.ts:5-10`
- Test: `apps/backend/tests/ai.test.ts:23-27`

- [ ] **Step 1: Update the RAM prompt test first**

In `ai.test.ts`, replace the `PROMPT_BY_CATEGORY` RAM test body (lines ~24-26) with:

```ts
    expect(PROMPT_BY_CATEGORY.RAM).toContain('PC4');
    expect(PROMPT_BY_CATEGORY.RAM).toContain('"generation"');
    expect(PROMPT_BY_CATEGORY.RAM).toContain('Desktop|Server|Laptop');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/backend test -- -t "RAM prompt"`
Expected: FAIL — prompt does not yet contain `"generation"`.

- [ ] **Step 3: Rewrite the RAM prompt**

Replace the `RAM:` entry (lines 5–10) with:

```ts
  RAM: `You are reading a server/desktop/laptop RAM module label. Respond with a single minified JSON object and nothing else — no markdown, no code fences, no prose:
{"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"… GB","generation":"DDR2|DDR3|DDR4|DDR5","type":"Desktop|Server|Laptop","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx16|1Rx8|1Rx4|2Rx16|2Rx8|2Rx4|4Rx8|4Rx4|8Rx4","speed":"MT/s number only","partNumber":"…"}
GENERATION — use the "PC" code printed on the label, never infer from speed alone:
  PC2-… = DDR2, PC3-…/PC3L-… = DDR3, PC4-… = DDR4, PC5-… = DDR5.
CLASSIFICATION — the module form factor: SODIMM, UDIMM, RDIMM, or LRDIMM.
TYPE — derive from the form factor: SODIMM = Laptop, UDIMM = Desktop, RDIMM/LRDIMM/ECC = Server. Always emit type when classification is readable.
Only include a field if you can read or derive it confidently. Omit any field you are unsure about — do NOT guess.`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/backend test -- -t "RAM prompt"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/ai/prompts.ts apps/backend/tests/ai.test.ts
git commit -m "feat(ai): RAM prompt splits generation vs device type"
```

---

### Task 6: OCR model → Gemma 3 27B + temperature 0 + one JSON retry

**Files:**
- Modify: `apps/backend/src/ai/openrouter.ts:6,48-74`
- Test: `apps/backend/tests/ai.test.ts:67-94`

- [ ] **Step 1: Add a failing retry test**

In `ai.test.ts`, inside the `openRouterScan` describe, add:

```ts
  it('retries once when first reply is unparseable, then parses', async () => {
    const calls: string[] = ['not json', '{"brand":"Crucial"}'];
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: calls.shift()! } }] }), { status: 200 }),
    ));
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.fields.brand).toBe('Crucial');
    expect(calls.length).toBe(0);
  });
```

Also update the existing **"throws when content is unparseable"** test so both attempts fail — change its `mockFetch` line to:

```ts
    mockFetch(200, { choices: [{ message: { content: 'no json at all' } }] });
```

(It stays the same string; the fetch mock returns it for every call, so after one retry it still throws — assertion unchanged.)

- [ ] **Step 2: Run test to verify the retry test fails**

Run: `npm --prefix apps/backend test -- -t "retries once"`
Expected: FAIL — no retry yet; `parse` error thrown.

- [ ] **Step 3: Change model + temperature**

Line 6: change `const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';` to:

```ts
const DEFAULT_MODEL = 'google/gemma-3-27b-it';
```

In the request body change `temperature: 0.1,` to `temperature: 0,`.

- [ ] **Step 4: Extract the request into a retryable call**

Replace the body from `const res = await fetch(ENDPOINT, {` through the final `return { … }` with a helper that posts a messages array and one retry on parse-miss:

```ts
  const baseContent = [
    { type: 'text', text: PROMPT_BY_CATEGORY[category] },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];

  async function ask(messages: unknown[]): Promise<string> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://recycle-erp.local',
        'X-Title': 'Recycle ERP',
      },
      body: JSON.stringify({
        model: env.OPENROUTER_OCR_MODEL ?? DEFAULT_MODEL,
        temperature: 0,
        max_tokens: 1024,
        messages,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${errBody}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter: no content in response');
    return content;
  }

  const first = await ask([{ role: 'user', content: baseContent }]);
  let json = parseModelJson(first);
  if (!json) {
    const second = await ask([
      { role: 'user', content: baseContent },
      { role: 'assistant', content: first },
      { role: 'user', content: 'Your previous reply was not valid JSON. Reply with ONLY the JSON object — no prose, no code fences.' },
    ]);
    json = parseModelJson(second);
  }
  if (!json) throw new Error('OpenRouter: could not parse JSON from response');

  return {
    category,
    confidence: 0.85,
    fields: json as Record<string, string>,
    provider: 'openrouter',
  };
```

- [ ] **Step 5: Run the AI test suite**

Run: `npm --prefix apps/backend test -- ai`
Expected: PASS — including "retries once", "throws when content is unparseable", "throws on non-2xx", "parses fenced JSON content".

- [ ] **Step 6: Typecheck + commit**

Run: `npm --prefix apps/backend run typecheck` → PASS

```bash
git add apps/backend/src/ai/openrouter.ts apps/backend/tests/ai.test.ts
git commit -m "feat(ai): Gemma 3 27B default, temp 0, one JSON retry"
```

---

### Task 7: Stub fixture

**Files:**
- Modify: `apps/backend/src/ai/stub.ts:8-19`
- Test: `apps/backend/tests/ai.test.ts:31-36`

- [ ] **Step 1: Extend the stub assertion**

In the "returns canned RAM extraction by default" test add after the `brand` assertion:

```ts
    expect(r.fields.generation).toBe('DDR4');
    expect(r.fields.type).toBe('Server');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix apps/backend test -- -t "canned RAM"`
Expected: FAIL — `generation` undefined.

- [ ] **Step 3: Update the RAM stub fields**

In `STUB_BY_CATEGORY.RAM.fields` replace `type: 'DDR4',` with:

```ts
      generation: 'DDR4',
      type: 'Server',
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix apps/backend test -- ai`
Expected: PASS (whole AI suite).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/ai/stub.ts apps/backend/tests/ai.test.ts
git commit -m "test(ai): stub RAM has generation + device type"
```

---

### Task 8: Frontend types, catalog constants, i18n

**Files:**
- Modify: `apps/frontend/src/lib/types.ts` (3 shapes: ~37, 122, 173)
- Modify: `apps/frontend/src/lib/catalog.ts:10`
- Modify: `apps/frontend/src/lib/i18n.tsx:99,373`

- [ ] **Step 1: Add `generation` to all three line shapes**

Run: `grep -n "type: string | null;" apps/frontend/src/lib/types.ts`
For each of the three RAM-bearing shapes (lines ~37, 122, 173) add directly above the `type:` line:

```ts
  generation: string | null;
```

- [ ] **Step 2: catalog.ts — name the generation list, add device types**

Change line 10 `export const RAM_TYPES = catalog.RAM_TYPE;` to:

```ts
export const RAM_GENERATIONS = catalog.RAM_TYPE; // DDR3/DDR4/DDR5
export const RAM_DEVICE_TYPES = ['Desktop', 'Server', 'Laptop'] as const;
```

(The `catalog_options` DB key stays `RAM_TYPE`; only the exported name changes.)

- [ ] **Step 3: i18n — add `generation` key (en + zh)**

`i18n.tsx:99` — after `type: 'Type',` add:

```ts
    generation: 'Generation',
```

`i18n.tsx:373` — in the zh block change `brand: '品牌', type: '类型', capacity: '容量', speedMhz: '速度 (MHz)',` to:

```ts
    brand: '品牌', type: '类型', generation: '代数', capacity: '容量', speedMhz: '速度 (MHz)',
```

- [ ] **Step 4: Typecheck**

Run: `npm --prefix apps/frontend run typecheck`
Expected: FAILS — `RAM_TYPES` import in DesktopSubmit.tsx now unresolved, new `generation` field unset in literals. Fixed in Tasks 9–13.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/types.ts apps/frontend/src/lib/catalog.ts apps/frontend/src/lib/i18n.tsx
git commit -m "feat(fe): generation type, catalog + i18n"
```

---

### Task 9: Mobile RAM form (`PhCategoryFields.tsx`)

**Files:**
- Modify: `apps/frontend/src/components/PhCategoryFields.tsx:29-34,48-54`

- [ ] **Step 1: Rebind the DDR select to `generation`**

Replace the field block at lines 29–34 (`<label>{t('type')}</label>` … DDR `<select>`) with:

```tsx
          <div className="ph-field">
            <label>{t('generation')}</label>
            <select className={selectCls} value={value.generation ?? 'DDR4'} onChange={e => onChange('generation', e.target.value)}>
              <option>DDR3</option><option>DDR4</option><option>DDR5</option>
            </select>
          </div>
```

- [ ] **Step 2: Add a new `type` (device) select**

Immediately after the `classification`/`rank` `ph-field-row` (closes at line ~61), before the partNumber field, insert:

```tsx
        <div className="ph-field">
          <label>{t('type')}</label>
          <select className={selectCls} value={value.type ?? 'Server'} onChange={e => onChange('type', e.target.value)}>
            <option>Desktop</option><option>Server</option><option>Laptop</option>
          </select>
        </div>
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix apps/frontend run typecheck`
Expected: PhCategoryFields.tsx clean (other files still error — later tasks).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/components/PhCategoryFields.tsx
git commit -m "feat(fe): mobile RAM form — generation + device type"
```

---

### Task 10: Desktop RAM form (`DesktopSubmit.tsx`)

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx:10,195,339,957`

- [ ] **Step 1: Fix the catalog import (line ~10)**

Change `RAM_BRANDS, RAM_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP, RAM_SPEED,` to:

```ts
  RAM_BRANDS, RAM_GENERATIONS, RAM_DEVICE_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP, RAM_SPEED,
```

- [ ] **Step 2: Generation select + new device-type select (line ~957)**

Replace the line:

```tsx
        <CatSelect value={line.type} options={RAM_TYPES} onChange={v => set({ type: v })} />
```

with:

```tsx
        <CatSelect value={line.generation} options={RAM_GENERATIONS} onChange={v => set({ generation: v })} />
        <CatSelect value={line.type} options={RAM_DEVICE_TYPES as unknown as string[]} onChange={v => set({ type: v })} />
```

(If `CatSelect` requires a label/field-row wrapper, mirror the wrapper of the adjacent `RAM_CLASS` select for the new control.)

- [ ] **Step 3: Patch builder (line ~195)**

Change `...(f.type ? { type: f.type } : {}),` to:

```ts
    ...(f.generation ? { generation: f.generation } : {}),
    ...(f.type       ? { type: f.type }             : {}),
```

- [ ] **Step 4: Line mapping (line ~339)**

After `type: l.type ?? null,` add:

```ts
    generation: l.generation ?? null,
```

- [ ] **Step 5: Typecheck**

Run: `npm --prefix apps/frontend run typecheck`
Expected: DesktopSubmit.tsx clean.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSubmit.tsx
git commit -m "feat(fe): desktop RAM form — generation + device type"
```

---

### Task 11: Draft mappers (`SubmitForm`, `DesktopEditOrder`, `MobileApp`)

**Files:**
- Modify: `apps/frontend/src/pages/SubmitForm.tsx:29,52,71`
- Modify: `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx:669,698,722`
- Modify: `apps/frontend/src/MobileApp.tsx:113,254,319`

- [ ] **Step 1: SubmitForm.tsx**

- Line ~29 `blankDefaults`: after `type: null,` add `generation: null,`
- Line ~52 `aiPatch`: after `if (f.type) out.type = f.type as string;` add:

```ts
  if (f.generation)     out.generation     = f.generation as string;
```

- Line ~71 `aiDefaults`: after `type: (f.type as string) ?? null,` add:

```ts
    generation:     (f.generation as string)     ?? null,
```

- [ ] **Step 2: DesktopEditOrder.tsx (lines ~669, 698, 722)**

For each `type: l.type ?? …,` line add an adjacent line with the same `?? undefined`/`?? null` suffix:

```ts
    generation:     l.generation ?? <same-suffix>,
```

- [ ] **Step 3: MobileApp.tsx (lines ~113, 254, 319)**

For each `type: l.type ?? null,` / `type: l.type,` add an adjacent `generation:` line with the identical right-hand side.

- [ ] **Step 4: Typecheck**

Run: `npm --prefix apps/frontend run typecheck`
Expected: these three files clean.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/SubmitForm.tsx apps/frontend/src/pages/desktop/DesktopEditOrder.tsx apps/frontend/src/MobileApp.tsx
git commit -m "feat(fe): map generation through draft builders"
```

---

### Task 12: Short labels use `generation`, not `type`

**Files:**
- Modify: `apps/frontend/src/pages/SubmitForm.tsx:122`
- Modify: `apps/frontend/src/MobileApp.tsx:336`
- Modify: `apps/frontend/src/pages/desktop/DesktopDashboard.tsx:240`
- Modify: `apps/frontend/src/pages/desktop/DesktopTransfers.tsx:29`
- Modify: `apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx:84`
- Modify: `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx:171`
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx:500,779`
- Modify: `apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx:195`

- [ ] **Step 1: Swap the DDR token in every RAM short-label**

In each location the RAM label is built as `[brand, capacity, type]` / `${brand} ${capacity} ${type}`. Replace the `type` reference with `generation` so labels stay e.g. "Samsung 32GB DDR4". Concretely:

- `SubmitForm.tsx:122` — `[line.brand, line.capacity, line.type]` → `[line.brand, line.capacity, line.generation]`
- `MobileApp.tsx:336` — `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}` → use `${l.generation ?? ''}`
- `DesktopDashboard.tsx:240` — `${r.type ?? ''}` → `${r.generation ?? ''}`
- `DesktopTransfers.tsx:29` — `[r.brand, r.capacity, r.type, r.part_number]` → `[r.brand, r.capacity, r.generation, r.part_number]` (also add `generation` to its row type at line ~11)
- `DesktopActivityDrawer.tsx:84` — `${e.type ?? ''}` → `${e.generation ?? ''}` (also add `generation` to its row type at line ~20)
- `DesktopEditOrder.tsx:171` — `${l.type ?? ''}` → `${l.generation ?? ''}`
- `DesktopSubmit.tsx:500,779` — `${l.type ?? ''}` / `${line.type ?? ''}` → `${l.generation ?? ''}` / `${line.generation ?? ''}`
- `DesktopInventoryEdit.tsx:195` — `${item.type ?? ''}` → `${item.generation ?? ''}` (also add `generation` to its row type at line ~13)

- [ ] **Step 2: Typecheck**

Run: `npm --prefix apps/frontend run typecheck`
Expected: only DesktopInventory/Inventory display rows remain (next task) — these label files clean.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/pages apps/frontend/src/MobileApp.tsx
git commit -m "feat(fe): RAM short labels use generation"
```

---

### Task 13: Inventory views — Generation row/column

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx:406`
- Modify: `apps/frontend/src/pages/desktop/DesktopInventory.tsx:23`
- Modify: `apps/frontend/src/pages/Inventory.tsx:20`

- [ ] **Step 1: DesktopInventoryEdit — add Generation row**

At line ~406, above `<Row label="Type" value={item.type} />` add:

```tsx
              <Row label="Generation"     value={item.generation} />
```

(`Type` row now naturally shows Desktop/Server/Laptop.)

- [ ] **Step 2: DesktopInventory.tsx + Inventory.tsx row types**

In each file, the inventory item type declares `type: string | null;` (DesktopInventory ~23, Inventory ~20). Add directly above it:

```ts
  generation: string | null;
```

If either page renders a column/cell for `type` as the DDR value, add a sibling cell/column reading `generation` (mirror the existing `type` cell markup). If `type` is only passed through, no display change is needed.

- [ ] **Step 3: Frontend typecheck (whole app)**

Run: `npm --prefix apps/frontend run typecheck`
Expected: PASS (0 errors).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx apps/frontend/src/pages/desktop/DesktopInventory.tsx apps/frontend/src/pages/Inventory.tsx
git commit -m "feat(fe): inventory views show RAM generation"
```

---

### Task 14: Full verification

- [ ] **Step 1: Backend suite + typecheck**

Run: `npm --prefix apps/backend test && npm --prefix apps/backend run typecheck`
Expected: all tests pass, 0 type errors.

- [ ] **Step 2: Frontend build**

Run: `npm --prefix apps/frontend run build`
Expected: `tsc -b` clean, `vite build` succeeds.

- [ ] **Step 3: Manual smoke (stub provider)**

With the stub provider (no `OPENROUTER_API_KEY`), scan a RAM label in the mobile flow: form shows separate **Generation** (DDR4) and **Type** (Server) selects; saved line label reads "Samsung 32GB DDR4".

- [ ] **Step 4: Final commit (if any residual)**

```bash
git add -A && git commit -m "chore: ram type/generation split — verification" || true
```

---

## Self-Review

- **Spec coverage:** Part 1 (migration + backend types + routes) → Tasks 1–4; Part 2 (model, prompt, retry, stub, tests) → Tasks 5–7; Part 3 (fe types, forms, mappers, labels, inventory views, i18n) → Tasks 8–13. Spec's `market.ts`/`scan.ts` mentions resolved in the documented scope-deviation note. ✔
- **Placeholder scan:** No TBD/TODO; every code step shows concrete code. Grep-guided steps (inventory.ts mapping, MobileApp) give the exact command and the transformation rule because the occurrences are repetitive-identical. ✔
- **Type consistency:** `generation` used identically across backend (`OrderLine`, `LineInput`, `LineFields`, `SourceRow`) and frontend (3 shapes + per-page row types). Catalog rename `RAM_TYPES`→`RAM_GENERATIONS` + new `RAM_DEVICE_TYPES` consistent between catalog.ts (Task 8) and DesktopSubmit import (Task 10). ✔
