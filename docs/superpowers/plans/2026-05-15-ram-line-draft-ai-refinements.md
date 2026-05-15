# RAM Line Submission Refinements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict/expand RAM catalog lists, inline AI capture with a visible image, persist orders as server-side drafts with per-line confirm, add a guarded delete-order action, and make AI extraction honest.

**Architecture:** Backend gets a `POST /api/orders/draft` endpoint and a guarded `DELETE /api/orders/:id`; the existing `PATCH /api/orders/:id` already supports per-line status changes and line autosave (lines insert with the status the client sends). Frontend creates a draft order when the submit screen opens, autosaves lines as `Draft`, and a per-line "Confirm" flips status `Draft → In Transit` (a confirmed line is inventory — no new table). AI autofill is gated by a confidence floor; the captured image is shown from the returned `deliveryUrl`.

**Tech Stack:** Hono (Cloudflare Workers) + `postgres` tagged-template SQL backend; React + TypeScript (Vite) frontend; pnpm workspace. **No unit-test harness exists** — verification is `pnpm typecheck`, `pnpm db:reset`/`db:seed`, SQL spot-checks, and manual dev-server checks.

**Spec:** `docs/superpowers/specs/2026-05-15-ram-line-draft-ai-refinements-design.md`

---

## File Structure

- `apps/backend/scripts/seed.mjs` — RAM brand/rank/speed source arrays (lines 90, 93, 95); reseeds `catalog_options`.
- `apps/backend/src/routes/orders.ts` — add `POST /draft` and `DELETE /:id` (file currently ends with `export default orders;`).
- `apps/backend/src/ai.ts` — `CONFIDENCE_FLOOR` constant, stub confidence honesty, RAM prompt enum widening.
- `apps/frontend/src/lib/api.ts` — typed helpers `createDraftOrder`, `confirmOrderLine`, `deleteOrder`.
- `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — image thumbnail, confidence-gated `lineFromScan`, draft+confirm wiring.
- `apps/frontend/src/pages/SubmitForm.tsx` — inline AI capture button, image thumbnail, confidence-gated autofill.
- `apps/frontend/src/MobileApp.tsx` — collapse the separate `camera` phase into the form; draft create + confirm wiring.
- `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` — red Delete-order button + typed-ID modal.
- `apps/frontend/src/pages/OrderReview.tsx` — mobile Delete-order button + typed-ID confirm (minimal).

---

### Task 1: Restrict/expand RAM catalog lists (R1, R2, R3)

**Files:**
- Modify: `apps/backend/scripts/seed.mjs:90`, `:93`, `:95`

- [ ] **Step 1: Edit the three arrays**

In `apps/backend/scripts/seed.mjs` replace these exact lines:

```js
const RAM_BRANDS = ['Samsung', 'Hynix', 'Micron', 'Kingston', 'Crucial', 'Corsair'];
```
with:
```js
const RAM_BRANDS = ['Samsung', 'SK Hynix', 'Micron', 'Kingston', 'Other'];
```

Replace:
```js
const RAM_RANK   = ['1Rx4', '1Rx8', '2Rx4', '2Rx8', '4Rx4'];
```
with:
```js
const RAM_RANK   = ['1Rx16', '1Rx8', '1Rx4', '2Rx16', '2Rx8', '2Rx4', '4Rx8', '4Rx4', '8Rx4'];
```

Replace:
```js
const RAM_SPEED  = ['1600','2133','2400','2666','3200','4800','5600'];
```
with:
```js
const RAM_SPEED  = ['800','1066','1333','1600','1866','2133','2400','2666','2933','3200','4000','4400','4800','5200','5600','6000','6400','6800','7200','7600','8000'];
```

- [ ] **Step 2: Reseed the catalog**

Run: `pnpm --filter recycle-erp-backend db:seed`
Expected: completes without error, prints `· Seeding lookup tables…`. (`db:seed` runs `DELETE FROM catalog_options` then reinserts — existing `order_lines` rows are untouched.)

- [ ] **Step 3: Verify the option rows**

Run:
```bash
node -e "import('postgres').then(async ({default:postgres})=>{const sql=postgres(process.env.DATABASE_URL);for(const g of ['RAM_BRAND','RAM_RANK','RAM_SPEED']){const r=await sql\`SELECT value FROM catalog_options WHERE \"group\"=\${g} ORDER BY position\`;console.log(g, r.map(x=>x.value).join(','));}await sql.end();})"
```
Expected output:
```
RAM_BRAND Samsung,SK Hynix,Micron,Kingston,Other
RAM_RANK 1Rx16,1Rx8,1Rx4,2Rx16,2Rx8,2Rx4,4Rx8,4Rx4,8Rx4
RAM_SPEED 800,1066,1333,1600,1866,2133,2400,2666,2933,3200,4000,4400,4800,5200,5600,6000,6400,6800,7200,7600,8000
```
(If `DATABASE_URL` is not in the shell env, prefix the command with it from `apps/backend/.dev.vars` / wrangler config.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/scripts/seed.mjs
git commit -m "feat(catalog): restrict RAM brands, complete rank/speed lists"
```

---

### Task 2: Backend `POST /api/orders/draft` (R5)

Creates an empty order with `lifecycle: 'draft'` so in-progress work is persisted from the start. Reuses the existing `SO-####` id generator.

**Files:**
- Modify: `apps/backend/src/routes/orders.ts` (insert a new route immediately before the final `export default orders;` line)

- [ ] **Step 1: Add the draft endpoint**

In `apps/backend/src/routes/orders.ts`, immediately above `export default orders;`, add:

```ts
// ── Create an empty Draft order so the submit screen can autosave lines as
// the purchaser builds them (nothing is lost if they leave mid-entry).
orders.post('/draft', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { category: LineCategory; warehouseId?: string; payment?: 'company' | 'self'; notes?: string }
    | null;
  if (!body || !body.category) {
    return c.json({ error: 'category is required' }, 400);
  }

  const maxRow = (await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 1288) AS max
    FROM orders WHERE id LIKE 'SO-%' AND id ~ '^SO-[0-9]+$'
  `)[0] as { max: number };
  const newId = 'SO-' + (maxRow.max + 1);

  await sql`
    INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
    VALUES (
      ${newId}, ${u.id}, ${body.category},
      ${body.warehouseId ?? null}, ${body.payment ?? 'company'}, ${body.notes ?? null},
      ${null}, 'draft'
    )
  `;

  return c.json({ id: newId }, 201);
});
```

(`LineCategory` and `getDb` are already imported in this file — confirm at the top; the existing `orders.post('/')` uses both.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Smoke-test the endpoint**

Start the backend (`pnpm dev:backend`) in another shell, then with a valid auth cookie/token (reuse the same auth the frontend uses — or test via the UI in Task 8). Minimal check: confirm the route is registered by hitting it and getting `400 {"error":"category is required"}` for an empty body, and `201 {"id":"SO-####"}` for `{"category":"RAM"}`.
Expected: `201` with an `SO-` id; a row exists: `SELECT id, lifecycle FROM orders WHERE id = 'SO-####'` → `lifecycle = 'draft'`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/orders.ts
git commit -m "feat(orders): POST /api/orders/draft for eager draft persistence"
```

---

### Task 3: Backend `DELETE /api/orders/:id` (R6)

Allowed only while `lifecycle = 'draft'`, only for the order owner or a manager, and rejected with `409` if any line is referenced by a sell order (`sell_order_lines.inventory_id`).

**Files:**
- Modify: `apps/backend/src/routes/orders.ts` (insert before `export default orders;`, after the draft route)

- [ ] **Step 1: Add the delete endpoint**

```ts
// ── Delete a Draft order. Guarded: only the owner/manager, only while still
// a Draft, and never if a line has already been sold.
orders.delete('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const existing = (await sql`
    SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1
  `)[0] as { user_id: string; lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (existing.lifecycle !== 'draft') {
    return c.json({ error: 'Only Draft orders can be deleted' }, 403);
  }

  const sold = (await sql`
    SELECT 1 FROM sell_order_lines sol
    JOIN order_lines ol ON ol.id = sol.inventory_id
    WHERE ol.order_id = ${id} LIMIT 1
  `)[0];
  if (sold) {
    return c.json({ error: 'A line in this order is referenced by a sell-order and cannot be deleted' }, 409);
  }

  await sql`DELETE FROM orders WHERE id = ${id}`; // order_lines cascade via FK
  return c.json({ ok: true });
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke-test**

Create a draft via Task 2's endpoint, then `DELETE /api/orders/SO-####`.
Expected: `200 {"ok":true}`; `SELECT count(*) FROM orders WHERE id='SO-####'` → `0`.
Then `DELETE` a non-draft order id → `403 {"error":"Only Draft orders can be deleted"}`.
Then `DELETE` a missing id → `404`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/orders.ts
git commit -m "feat(orders): guarded DELETE /api/orders/:id (Draft-only, owner/manager, not sold)"
```

---

### Task 4: Backend AI honesty — confidence floor, stub, prompt enums (R7, R1–R3 sync)

**Files:**
- Modify: `apps/backend/src/ai.ts` (`ScanResult` block at lines 11–16; `PROMPT_BY_CATEGORY` RAM entry; stub return in `scanLabel`)

- [ ] **Step 1: Export a confidence floor constant**

In `apps/backend/src/ai.ts`, directly below the `ScanResult` type (after line 16, `};`), add:

```ts
// Below this overall confidence we do NOT autofill the form — the user
// enters the line manually. Keep in sync with the frontend gate.
export const CONFIDENCE_FLOOR = 0.6;
```

- [ ] **Step 2: Widen the RAM prompt enums to match the catalog**

In `PROMPT_BY_CATEGORY`, replace the `RAM:` entry with:

```ts
  RAM: `You are reading a server RAM module label. Extract these fields and respond as compact JSON only:
{"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"… GB","type":"DDR3|DDR4|DDR5","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx16|1Rx8|1Rx4|2Rx16|2Rx8|2Rx4|4Rx8|4Rx4|8Rx4","speed":"MT/s number only","partNumber":"…"}
Only include a field if you can read it clearly on the label. Omit any field you are unsure about — do NOT guess. No prose.`,
```

- [ ] **Step 3: Make the stub honest in dev**

The stub returns canned full specs. To exercise the honest path in dev, gate the stub's confidence on an env flag. Replace the stub return inside `scanLabel`:

```ts
  if (isStub(env)) {
    return { ...STUB_BY_CATEGORY[category], provider: 'stub' };
  }
```
with:
```ts
  if (isStub(env)) {
    const canned = STUB_BY_CATEGORY[category];
    // STUB_LOW_CONF=true simulates an unreadable label so the manual-entry
    // path can be exercised without a real model.
    if ((env.STUB_LOW_CONF ?? 'false').toLowerCase() === 'true') {
      return { category, confidence: 0.3, fields: {}, provider: 'stub' };
    }
    return { ...canned, provider: 'stub' };
  }
```

- [ ] **Step 4: Add the env flag to the type**

In `apps/backend/src/types.ts`, find the `Env` type and add (next to the existing `STUB_OCR?` field):

```ts
  STUB_LOW_CONF?: string;
```
Run: `grep -n "STUB_OCR" apps/backend/src/types.ts` to locate the exact line; add `STUB_LOW_CONF?: string;` on the following line with matching indentation.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/ai.ts apps/backend/src/types.ts
git commit -m "feat(ai): confidence floor, honest stub, RAM prompt enums match catalog"
```

---

### Task 5: Frontend API helpers (R5, R6)

**Files:**
- Modify: `apps/frontend/src/lib/api.ts` (the file already exports an `api` object with `get/post/patch/delete/upload` at ~lines 60–65)

- [ ] **Step 1: Add typed helpers**

At the end of `apps/frontend/src/lib/api.ts`, after the `api` object definition, add:

```ts
import type { Category } from './types';

export const createDraftOrder = (
  category: Category,
  meta?: { warehouseId?: string; payment?: 'company' | 'self'; notes?: string },
) => api.post<{ id: string }>('/api/orders/draft', { category, ...meta });

// Promote a single draft line to a confirmed inventory product.
export const confirmOrderLine = (orderId: string, lineId: string) =>
  api.patch<{ ok: true }>(`/api/orders/${orderId}`, {
    lines: [{ id: lineId, status: 'In Transit' }],
  });

export const deleteOrder = (orderId: string) =>
  api.delete<{ ok: true }>(`/api/orders/${orderId}`);
```

If `import type { Category }` already exists at the top of the file, do not duplicate it — instead add `createDraftOrder`/`confirmOrderLine`/`deleteOrder` only and reuse the existing import. Run `grep -n "from './types'" apps/frontend/src/lib/api.ts` first; if a type import line exists, append `Category` to it instead of adding a new import.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/api.ts
git commit -m "feat(api): draft-order, confirm-line, delete-order client helpers"
```

---

### Task 6: Desktop — visible image + confidence-gated autofill (R4, R7)

`DesktopSubmit` already has an inline "AI auto-fill" upload (`onAiUpload`, line ~261) and `lineFromScan` (line ~206). Add: gate autofill by confidence, and show the captured image.

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` (`lineFromScan` ~206–225; `onAiFileChosen` ~267–289; the active-line drawer render)

- [ ] **Step 1: Add a shared confidence floor on the frontend**

In `apps/frontend/src/lib/status.ts` (or `lib/catalog.ts` if you prefer co-location with lookups), add and export:

```ts
// Keep in sync with backend ai.ts CONFIDENCE_FLOOR.
export const AI_CONFIDENCE_FLOOR = 0.6;
```

- [ ] **Step 2: Gate `lineFromScan` by confidence**

In `DesktopSubmit.tsx`, import the floor:

```ts
import { AI_CONFIDENCE_FLOOR } from '../../lib/status';
```

Change `lineFromScan` so that when `scan.confidence < AI_CONFIDENCE_FLOOR` it returns a blank line (keeping only the image reference, not the extracted fields):

```ts
function lineFromScan(category: Category, scan: ScanResponse): Line {
  const base = blankLine(category);
  base.scanImageId = scan.imageId ?? null;
  base.scanConfidence = scan.confidence ?? null;
  if ((scan.confidence ?? 0) < AI_CONFIDENCE_FLOOR) {
    return base; // unreadable — user fills it in manually
  }
  const f = scan.extracted ?? {};
  return {
    ...base,
    brand:          f.brand          ?? base.brand,
    capacity:       f.capacity       ?? base.capacity,
    type:           f.type           ?? base.type,
    classification: f.classification ?? base.classification,
    rank:           f.rank           ?? base.rank,
    speed:          f.speed          ?? base.speed,
    interface:      f.interface      ?? base.interface,
    formFactor:     f.formFactor     ?? base.formFactor,
    description:    f.description    ?? base.description,
    partNumber:     f.partNumber     ?? base.partNumber,
  };
}
```

(Match the exact field names on `Line` — confirm against `blankLine` at line ~197. The point: only copy fields the extractor returned, and only above the floor.)

- [ ] **Step 3: Surface the unreadable case + show the image**

In `onAiFileChosen`, after `const newLine = lineFromScan(category, scan);`, set a user-visible note when low confidence:

```ts
      const newLine = lineFromScan(category, scan);
      if ((scan.confidence ?? 0) < AI_CONFIDENCE_FLOOR) {
        setAiError("Couldn't read the label confidently — please enter the details manually.");
      }
```

(`setAiError` already exists and is rendered near the AI button — reuse it as the notice channel; it is informational here, not a failure.)

Carry `deliveryUrl` so it can be shown. Extend the `Line` type (search `scanImageId?: string | null;` ~line 157 and `scanImageId: string | null;` ~line 192) to also hold the URL:

```ts
  scanImageUrl?: string | null;
```
Set it in `lineFromScan`: `base.scanImageUrl = scan.deliveryUrl ?? null;` and include `scanImageUrl: null` in `blankLine`.

In the active-line drawer (where line fields are edited), render the thumbnail when present. Add near the top of the drawer body:

```tsx
{line.scanImageUrl && (
  <img
    src={line.scanImageUrl}
    alt="Captured label"
    style={{ maxWidth: 220, borderRadius: 8, border: '1px solid var(--border)', marginBottom: 12 }}
  />
)}
```

(Place it just inside the drawer content container, above the field groups. Use the existing `line` variable in scope for the active drawer.)

- [ ] **Step 4: Typecheck + manual check**

Run: `pnpm --filter recycle-erp-frontend typecheck` → PASS.
Manual (dev server, desktop): start a RAM order, click AI auto-fill, pick an image. With the default stub it autofills + shows the image. Set `STUB_LOW_CONF=true` in backend `.dev.vars`, restart backend, retry: fields stay blank, the "enter the details manually" notice shows, image still appears.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/status.ts apps/frontend/src/pages/desktop/DesktopSubmit.tsx
git commit -m "feat(submit-desktop): show captured image, gate AI autofill by confidence"
```

---

### Task 7: Mobile — inline AI capture + image + confidence gate (R4, R7)

Collapse the standalone `camera` phase into the form: the Add RAM line form shows an "AI capture" button that opens capture inline, autofills (gated), and shows the image.

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx` (`pickCategory` ~line 85, `onDetected` ~93, the `capture.phase === 'camera'` render ~243, `addAnotherItem` ~115)
- Modify: `apps/frontend/src/pages/SubmitForm.tsx` (`aiPatch`/`aiDefaults` ~40–80; component body; render add an AI-capture button + image)

- [ ] **Step 1: Route RAM straight to the form**

In `MobileApp.tsx` `pickCategory`, change the RAM branch so RAM no longer opens the camera first:

```ts
  const pickCategory = (cat: Category) => {
    setCapture({ phase: 'form', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
  };
```

In `addAnotherItem`, replace the RAM-vs-other branch with always `phase: 'form'`:

```ts
  const addAnotherItem = () => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return { phase: 'form', category: c.category, detected: null, lines: c.lines, editingId: c.editingId, editingLineIdx: null, returnTo: 'review' };
    });
  };
```

Leave the `capture.phase === 'camera'` render block in place but unreachable from RAM (it is now dead for the submit flow; do not delete other consumers without checking — `grep -n "phase: 'camera'\\|phase === 'camera'" apps/frontend/src/MobileApp.tsx` and remove only if no remaining producers).

- [ ] **Step 2: Add an inline AI capture action to `SubmitForm`**

`SubmitForm` receives `onRescan` already (used to re-open camera). Repurpose the in-form AI button to upload an image directly to `/api/scan/label` and apply the result locally. In `SubmitForm.tsx` add, inside the component:

```tsx
import { api } from '../lib/api';
import { AI_CONFIDENCE_FLOOR } from '../lib/status';
import type { ScanResponse } from '../lib/types';

// ...inside SubmitForm:
const aiInputRef = useRef<HTMLInputElement | null>(null);
const [aiBusy, setAiBusy] = useState(false);
const [aiNote, setAiNote] = useState<string | null>(null);

const onAiPick: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  setAiBusy(true); setAiNote(null);
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('category', category);
    const scan = await api.upload<ScanResponse>('/api/scan/label', form);
    setForm(prev => {
      const next = { ...prev, scanImageId: scan.imageId ?? null, scanConfidence: scan.confidence ?? null, scanImageUrl: scan.deliveryUrl ?? null };
      if ((scan.confidence ?? 0) >= AI_CONFIDENCE_FLOOR) {
        const f = scan.extracted ?? {};
        if (f.brand) next.brand = f.brand;
        if (f.capacity) next.capacity = f.capacity;
        if (f.type) next.type = f.type;
        if (f.classification) next.classification = f.classification;
        if (f.rank) next.rank = f.rank;
        if (f.speed) next.speed = f.speed;
        if (f.interface) next.interface = f.interface;
        if (f.formFactor) next.formFactor = f.formFactor;
        if (f.description) next.description = f.description;
        if (f.partNumber) next.partNumber = f.partNumber;
      } else {
        setAiNote("Couldn't read the label confidently — please enter the details manually.");
      }
      return next;
    });
  } catch (err) {
    setAiNote(err instanceof Error ? err.message : 'AI scan failed');
  } finally {
    setAiBusy(false);
  }
};
```

(Use the form-state setter that already backs the fields — confirm its name by reading the component; the existing code initializes state from `aiDefaults/aiPatch/blankDefaults` and renders inputs bound to it. Replace `setForm`/`prev` with the actual state variable/updater in the file. Add `scanImageUrl?: string | null;` to the `DraftLine` type in `apps/frontend/src/lib/types.ts` near `scanImageId`.)

- [ ] **Step 3: Render the AI button + image in `SubmitForm`**

Near the top of the form's JSX (above the field inputs, where the AI confidence banner currently renders ~line 144), add:

```tsx
<input ref={aiInputRef} type="file" accept="image/*" capture="environment" hidden onChange={onAiPick} />
<button type="button" className="btn accent" disabled={aiBusy} onClick={() => aiInputRef.current?.click()}>
  {aiBusy ? 'Scanning…' : 'AI capture'}
</button>
{aiNote && <div className="hint" style={{ color: 'var(--warn)' }}>{aiNote}</div>}
{form.scanImageUrl && (
  <img src={form.scanImageUrl} alt="Captured label"
       style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)', margin: '8px 0' }} />
)}
```

(`capture="environment"` opens the camera on mobile; on desktop it is a file picker — single inline affordance for both, no separate camera screen. `form` = the actual state variable name in the file.)

- [ ] **Step 4: Typecheck + manual check**

Run: `pnpm --filter recycle-erp-frontend typecheck` → PASS.
Manual (dev server, mobile viewport): pick RAM → form opens directly (no camera screen) → tap "AI capture" → choose an image → confident stub autofills + image shows; with `STUB_LOW_CONF=true` fields stay blank, manual-entry note shows, image still shows.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/MobileApp.tsx apps/frontend/src/pages/SubmitForm.tsx apps/frontend/src/lib/types.ts
git commit -m "feat(submit-mobile): inline AI capture, visible image, confidence-gated autofill"
```

---

### Task 8: Desktop — eager draft + per-line confirm (R5)

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` (`OrderForm` body; `onSubmit` call site at line ~121–127; the active-line drawer "Confirm line" button at line ~813)

- [ ] **Step 1: Create the draft when the order form mounts**

In the `OrderForm` component, add draft bootstrap:

```tsx
import { createDraftOrder, confirmOrderLine } from '../../lib/api';

const [draftId, setDraftId] = useState<string | null>(null);
useEffect(() => {
  let alive = true;
  createDraftOrder(category)
    .then(r => { if (alive) setDraftId(r.id); })
    .catch(() => { if (alive) setAiError('Could not start a draft order — retry.'); });
  return () => { alive = false; };
}, [category]);
```

- [ ] **Step 2: Autosave a line as Draft when added**

When a line is appended (in `addLine` and in `onAiFileChosen` after `setLines`), persist it to the draft as a `Draft`-status line and capture its server id. Add a helper:

```tsx
const persistDraftLine = async (line: Line, idx: number) => {
  if (!draftId) return;
  try {
    await api.patch(`/api/orders/${draftId}`, {
      addLines: [{
        category: line.category, brand: line.brand ?? null, capacity: line.capacity ?? null,
        type: line.type ?? null, classification: line.classification ?? null, rank: line.rank ?? null,
        speed: line.speed ?? null, interface: line.interface ?? null, formFactor: line.formFactor ?? null,
        description: line.description ?? null, partNumber: line.partNumber ?? null,
        condition: line.condition, qty: Number(line.qty) || 1, unitCost: Number(line.unitCost) || 0,
        status: 'Draft',
      }],
    });
    // Re-fetch to learn the new line's server id for later confirm.
    const o = await api.get<{ lines: { id: string; position: number }[] }>(`/api/orders/${draftId}`);
    const sorted = [...o.lines].sort((a, b) => a.position - b.position);
    const serverId = sorted[idx]?.id;
    if (serverId) updateLine(idx, { _serverId: serverId } as Partial<Line>);
  } catch {
    setAiError('Could not save the line — it will be saved on confirm.');
  }
};
```

Add `_serverId?: string` to the `Line` type. Call `void persistDraftLine(newLine, next.length - 1)` after `setLines` in `onAiFileChosen`, and after `addLine` appends a blank line (persist on first meaningful edit instead if you prefer fewer empty rows — acceptable simplification: persist on Confirm only, see Step 3).

- [ ] **Step 3: Wire the "Confirm line" button to promote the line**

The drawer's Confirm button (line ~813) currently just calls `onClose`. Change it to: ensure the line is persisted, then confirm (status → In Transit). Replace:

```tsx
<button className="btn accent" onClick={onClose}>
  <Icon name="check" size={13} /> Confirm line
</button>
```
with:
```tsx
<button className="btn accent" disabled={confirming} onClick={async () => {
  setConfirming(true);
  try {
    if (!line._serverId) await persistDraftLine(line, activeIdx ?? 0);
    const sid = (line._serverId) ?? null;
    if (draftId && sid) await confirmOrderLine(draftId, sid);
    onClose();
  } catch {
    setAiError('Confirm failed — try again.');
  } finally {
    setConfirming(false);
  }
}}>
  <Icon name="check" size={13} /> Confirm line
</button>
```

Add `const [confirming, setConfirming] = useState(false);` in the drawer component scope. Thread `draftId`, `persistDraftLine`, and `activeIdx` into the drawer props if the drawer is a separate component (search the drawer component signature and add them to its `Props`).

- [ ] **Step 4: Replace whole-order submit with draft finalize**

The bottom "Submit order" handler currently does `await api.post('/api/orders', payload)` (line ~123). Since lines now live on the draft, change submit to flush any unpersisted/edited lines to the existing `draftId` via `PATCH` (update existing `_serverId` lines, `addLines` for any without one) instead of creating a new order:

```tsx
onSubmit={async () => {
  try {
    if (!draftId) throw new Error('No draft order');
    const withId = lines.filter(l => l._serverId);
    const withoutId = lines.filter(l => !l._serverId);
    await api.patch(`/api/orders/${draftId}`, {
      warehouseId: meta.warehouseId, payment: meta.payment, notes: meta.notes ?? null,
      totalCost: meta.totalCostOverride ?? null,
      lines: withId.map(l => ({ id: l._serverId!, status: 'In Transit',
        brand: l.brand ?? null, capacity: l.capacity ?? null, type: l.type ?? null,
        classification: l.classification ?? null, rank: l.rank ?? null, speed: l.speed ?? null,
        interface: l.interface ?? null, formFactor: l.formFactor ?? null,
        description: l.description ?? null, partNumber: l.partNumber ?? null,
        condition: l.condition, qty: Number(l.qty) || 1, unitCost: Number(l.unitCost) || 0 })),
      addLines: withoutId.map(l => ({ category: l.category, brand: l.brand ?? null,
        capacity: l.capacity ?? null, type: l.type ?? null, classification: l.classification ?? null,
        rank: l.rank ?? null, speed: l.speed ?? null, interface: l.interface ?? null,
        formFactor: l.formFactor ?? null, description: l.description ?? null,
        partNumber: l.partNumber ?? null, condition: l.condition,
        qty: Number(l.qty) || 1, unitCost: Number(l.unitCost) || 0, status: 'In Transit' })),
    });
    onDone({ msg: 'Order submitted — added to inventory', kind: 'success' });
  } catch (e) {
    onDone({ msg: e instanceof Error ? e.message : 'Submit failed', kind: 'error' });
  }
}}
```

Adjust `meta.*` names to the actual `meta` shape in the file (`buildPayload` at line ~330 shows the real field names — reuse them; `totalCostOverride` is referenced there).

- [ ] **Step 5: Typecheck + manual check**

Run: `pnpm --filter recycle-erp-frontend typecheck` → PASS.
Manual: open a RAM order — a draft `SO-####` now exists immediately (`SELECT id,lifecycle FROM orders ORDER BY created_at DESC LIMIT 1` → `draft`). Add a line, Confirm it → that line's `status` becomes `In Transit` (`SELECT status FROM order_lines WHERE order_id='SO-####'`). Reload the app mid-entry → the draft order still exists in the DB (work not lost).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSubmit.tsx
git commit -m "feat(submit-desktop): eager server draft + per-line confirm to inventory"
```

---

### Task 9: Mobile — eager draft + per-line confirm (R5)

Mirror Task 8 in the mobile flow. The mobile state machine collects `lines` in `MobileApp` and submits in the `review` phase.

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx` (`pickCategory` ~85, `onSaveLine` ~95, the `review`-phase submit handler, `cancelCapture`)

- [ ] **Step 1: Create a draft on category pick**

In `pickCategory`, after setting the form phase, create the draft and stash its id in the capture state:

```ts
const pickCategory = (cat: Category) => {
  setCapture({ phase: 'form', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
  createDraftOrder(cat)
    .then(r => setCapture(c => c.phase === 'idle' ? c : ({ ...c, draftId: r.id })))
    .catch(() => {/* surface via existing error toast */});
};
```

Add `draftId?: string` to the capture state type (search the `useState` that holds `capture` and extend its type union/objects with `draftId?: string`).

- [ ] **Step 2: Persist on save, confirm on review**

In `onSaveLine`, after computing `lines`, autosave the just-saved line as `Draft` to `capture.draftId` (via `api.patch(.../addLines [... status:'Draft'])`) — same payload shape as Task 8 Step 2. Keep the returned server id alongside each line (extend `DraftLine` with `_serverId?: string`).

In the `review`-phase submit (where the mobile flow currently `api.post('/api/orders', ...)` — `grep -n "api.post('/api/orders'" apps/frontend/src/MobileApp.tsx`), replace with a `PATCH` to `capture.draftId` that sets all lines `status: 'In Transit'` (reuse the Task 8 Step 4 body shape, mobile `meta` field names).

- [ ] **Step 3: Clean up abandoned empty draft on cancel**

In `cancelCapture`, if `capture.draftId` exists and no line was ever confirmed, best-effort delete it:

```ts
if (capture.phase !== 'idle' && capture.draftId) {
  deleteOrder(capture.draftId).catch(() => {});
}
```

(Import `deleteOrder` from `lib/api`. `DELETE` only succeeds while `lifecycle='draft'` — exactly the abandoned case — so this is safe.)

- [ ] **Step 4: Typecheck + manual check**

Run: `pnpm --filter recycle-erp-frontend typecheck` → PASS.
Manual (mobile viewport): pick RAM → a draft exists in DB → add + confirm a line → status `In Transit` → submit completes. Cancel a fresh empty draft → its row is gone.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/MobileApp.tsx apps/frontend/src/pages/SubmitForm.tsx apps/frontend/src/lib/types.ts
git commit -m "feat(submit-mobile): eager server draft + per-line confirm + abandoned-draft cleanup"
```

---

### Task 10: Delete-order UI with typed-ID confirmation (R6)

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` (header/action area near the buttons at ~line 175–185; `canEditOrder` at ~line 39; `order.status` Draft check at ~line 41)
- Modify: `apps/frontend/src/pages/OrderReview.tsx` (mobile — add equivalent minimal control)

- [ ] **Step 1: Desktop — red button + modal**

In `DesktopEditOrder.tsx` import the helper and add state:

```tsx
import { deleteOrder } from '../../lib/api';

const [showDelete, setShowDelete] = useState(false);
const [typedId, setTypedId] = useState('');
const [deleting, setDeleting] = useState(false);
const canDelete = canEditOrder && order.status === 'Draft';
```

Render the button in the action area (next to the existing top buttons ~line 175):

```tsx
{canDelete && (
  <button className="btn" style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
          onClick={() => { setTypedId(''); setShowDelete(true); }}>
    <Icon name="trash" size={13} /> Delete order
  </button>
)}
```

Add the modal at the end of the component's returned JSX:

```tsx
{showDelete && (
  <div className="modal-backdrop" onClick={() => !deleting && setShowDelete(false)}>
    <div className="modal" onClick={e => e.stopPropagation()}>
      <h3>Delete order {order.id}?</h3>
      <p>This permanently deletes the draft and all its lines. Type <strong>{order.id}</strong> to confirm.</p>
      <input className="input" value={typedId} onChange={e => setTypedId(e.target.value)} placeholder={order.id} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" disabled={deleting} onClick={() => setShowDelete(false)}>Cancel</button>
        <button className="btn" disabled={deleting || typedId !== order.id}
                style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
                onClick={async () => {
                  setDeleting(true);
                  try { await deleteOrder(order.id); window.location.reload(); }
                  catch (e) { alert(e instanceof Error ? e.message : 'Delete failed'); setDeleting(false); }
                }}>
          Delete
        </button>
      </div>
    </div>
  </div>
)}
```

(Reuse existing modal/backdrop CSS classes if the codebase has them — `grep -rn "modal-backdrop\\|\\.modal" apps/frontend/src/styles` ; if not present, inline minimal styles consistent with other overlays in the app. On success, navigating away/reloading is acceptable since the order no longer exists; if the app has a router-based "back to orders" callback, prefer calling that over `window.location.reload()`.)

- [ ] **Step 2: Mobile — minimal equivalent**

In `OrderReview.tsx`, if the order is a Draft and the user can edit it, add the same red "Delete order" button + a typed-ID confirm (a simple `prompt(`Type ${order.id} to confirm`)` is acceptable for mobile if there is no existing modal primitive; require exact match before calling `deleteOrder`). Keep it minimal and consistent with the page's existing button styling.

- [ ] **Step 3: Typecheck + manual check**

Run: `pnpm --filter recycle-erp-frontend typecheck` → PASS.
Manual: open a Draft order in desktop edit → red "Delete order" shows → modal Delete is disabled until the exact id is typed → deleting removes the order (`SELECT count(*) FROM orders WHERE id='SO-####'` → 0). Open a non-Draft order → no Delete button. Try deleting a draft whose line was added to a sell order → backend returns 409 and the alert shows the message.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopEditOrder.tsx apps/frontend/src/pages/OrderReview.tsx
git commit -m "feat(orders-ui): guarded delete-order with typed-ID confirmation"
```

---

## Final Verification

- [ ] `pnpm typecheck` (both workspaces) → PASS.
- [ ] `pnpm --filter recycle-erp-backend db:reset` runs clean; catalog spot-check (Task 1 Step 3) matches.
- [ ] Manual end-to-end (dev server): RAM order → draft row created on open → inline AI capture shows image, autofills only when confident, blank + manual-entry note when not → Confirm line flips `Draft→In Transit` → submit finalizes → Draft order delete requires exact typed id and is blocked for non-Draft / sold lines.

## Self-Review Notes

- **Spec coverage:** R1/R2/R3 → Task 1 (+ prompt sync Task 4). R4 → Tasks 6, 7. R5 → Tasks 2, 5, 8, 9. R6 → Tasks 3, 5, 10. R7 → Tasks 4, 6, 7.
- **No test harness:** verification uses `typecheck` + `db` + manual dev checks by design (repo has no unit-test framework) — this overrides the skill's default TDD step shape per the user's codebase reality.
- **Type consistency:** `_serverId`, `scanImageUrl` added to `Line`/`DraftLine` consistently; `createDraftOrder`/`confirmOrderLine`/`deleteOrder` signatures match call sites; `AI_CONFIDENCE_FLOOR` (frontend) mirrors `CONFIDENCE_FLOOR` (backend).
- **Known adaptation points (not placeholders):** exact state-variable names in `SubmitForm`/`DesktopSubmit` and the `meta` object shape must be read from the files during execution and substituted — the plan names the exact lines to read (`buildPayload` ~330, `blankLine` ~197, capture-state `useState`). These are integration bindings, not undefined behavior.
