# AI Scan Image Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the original camera-OCR photo backing an order line as a tappable thumbnail in the mobile line-edit form and the desktop product-detail drawer, opening a shared full-screen viewer.

**Architecture:** One backend change adds `scanImageUrl` to the `GET /api/orders/:id` line payload via a LEFT JOIN onto `label_scans`. A new shared `ImageLightbox` React component renders the full-screen view. Mobile (`SubmitForm`) and desktop (`LineDrawer`) each render a thumbnail in their existing edit surface and open the lightbox on tap.

**Tech Stack:** Hono + postgres.js (Cloudflare Workers backend), React 18 + Vite + TypeScript (frontend), pnpm workspace.

**Testing note:** This repo has no automated test harness (no vitest/jest/playwright, no `test` script). The automated gate per task is `pnpm --filter <app> typecheck`. Behavioral checks are manual browser steps, consistent with existing project specs.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backend/src/routes/orders.ts` | Add `scan_image_url` to single-order line query + mapper | Modify |
| `apps/frontend/src/lib/types.ts` | Add `scanImageUrl` to `OrderLine` and `DraftLine` | Modify |
| `apps/frontend/src/components/ImageLightbox.tsx` | Shared full-screen image viewer | Create |
| `apps/frontend/src/MobileApp.tsx` | Plumb `scanImageUrl` into edit DraftLine | Modify |
| `apps/frontend/src/pages/SubmitForm.tsx` | Thumbnail + lightbox trigger (mobile) | Modify |
| `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` | Extend `Line` type; thumbnail + lightbox in `LineDrawer` | Modify |
| `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` | Copy scan fields in `orderLineToEditLine` | Modify |

---

## Task 1: Backend — return `scanImageUrl` from single-order endpoint

**Files:**
- Modify: `apps/backend/src/routes/orders.ts` (lines 111–119 query, lines 140–161 mapper)

- [ ] **Step 1: Replace the lines query with a LEFT JOIN**

In `apps/backend/src/routes/orders.ts`, find the query in the `orders.get('/:id', ...)` handler (currently lines 111–119):

```ts
  const lines = await sql`
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, condition, qty,
           unit_cost::float AS unit_cost, sell_price::float AS sell_price,
           status, scan_image_id, scan_confidence, position
    FROM order_lines
    WHERE order_id = ${id}
    ORDER BY position ASC
  `;
```

Replace it with (every `order_lines` column qualified with `ol.` because `label_scans` also has `id`/`category` columns and would make them ambiguous):

```ts
  const lines = await sql`
    SELECT ol.id, ol.category, ol.brand, ol.capacity, ol.type, ol.classification,
           ol.rank, ol.speed, ol.interface, ol.form_factor, ol.description,
           ol.part_number, ol.condition, ol.qty,
           ol.unit_cost::float AS unit_cost, ol.sell_price::float AS sell_price,
           ol.status, ol.scan_image_id, ol.scan_confidence, ol.position,
           ls.delivery_url AS scan_image_url
    FROM order_lines ol
    LEFT JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
    WHERE ol.order_id = ${id}
    ORDER BY ol.position ASC
  `;
```

- [ ] **Step 2: Add `scanImageUrl` to the line mapper**

In the same handler, find the line mapper (currently lines 140–161). Locate this line inside `lines.map(l => ({ ... }))`:

```ts
        scanImageId: l.scan_image_id,
        scanConfidence: l.scan_confidence,
```

Change it to add the URL:

```ts
        scanImageId: l.scan_image_id,
        scanConfidence: l.scan_confidence,
        scanImageUrl: l.scan_image_url ?? null,
```

- [ ] **Step 3: Typecheck the backend**

Run: `pnpm --filter @recycle-erp/backend typecheck`
Expected: exits 0, no errors. (If the package name differs, use `pnpm --filter ./apps/backend typecheck`.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/orders.ts
git commit -m "feat(orders): return scanImageUrl on single-order lines"
```

---

## Task 2: Frontend types — add `scanImageUrl`

**Files:**
- Modify: `apps/frontend/src/lib/types.ts` (`OrderLine` ~line 50; `DraftLine` ~line 78)

- [ ] **Step 1: Add field to `OrderLine`**

In `apps/frontend/src/lib/types.ts`, in the `OrderLine` type, find:

```ts
  scanImageId: string | null;
  scanConfidence: number | null;
```

Change to:

```ts
  scanImageId: string | null;
  scanConfidence: number | null;
  scanImageUrl: string | null;
```

- [ ] **Step 2: Add field to `DraftLine`**

In the same file, in the `DraftLine` type, find:

```ts
  scanImageId?: string | null;
  scanConfidence?: number | null;
```

Change to:

```ts
  scanImageId?: string | null;
  scanConfidence?: number | null;
  scanImageUrl?: string | null;
```

- [ ] **Step 3: Typecheck the frontend**

Run: `pnpm --filter @recycle-erp/frontend typecheck`
Expected: exits 0, no errors. (If the package name differs, use `pnpm --filter ./apps/frontend typecheck`.)

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/types.ts
git commit -m "feat(types): add scanImageUrl to OrderLine and DraftLine"
```

---

## Task 3: Shared `ImageLightbox` component

**Files:**
- Create: `apps/frontend/src/components/ImageLightbox.tsx`

- [ ] **Step 1: Create the component**

Create `apps/frontend/src/components/ImageLightbox.tsx` with exactly this content:

```tsx
import { useEffect } from 'react';
import { Icon } from './Icon';

type Props = {
  url: string;
  alt?: string;
  onClose: () => void;
};

// Full-screen read-only image viewer. Sits above the desktop LineDrawer
// (z-index 80) and the mobile shell. Close via X button, backdrop click, or Esc.
export function ImageLightbox({ url, alt, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <button
        onClick={onClose}
        title="Close"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: 'none',
          background: 'rgba(255,255,255,0.16)',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
        }}
      >
        <Icon name="x" size={18} />
      </button>
      <img
        src={url}
        alt={alt ?? 'AI scan'}
        onClick={(e) => e.stopPropagation()}
        onError={onClose}
        style={{
          maxWidth: '92vw',
          maxHeight: '92vh',
          objectFit: 'contain',
          borderRadius: 8,
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify the `Icon` name `x` exists**

Run: `grep -n "x:" apps/frontend/src/components/Icon.tsx | head -3`
Expected: a match showing an `x` icon glyph is defined. (It is used by `LineDrawer` already, so this should pass. If it does NOT match, instead grep for the close-icon name used in `LineDrawer` — `grep -n "name=\"x\"\|name=\"close\"" apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — and use that name in `ImageLightbox.tsx`.)

- [ ] **Step 3: Typecheck the frontend**

Run: `pnpm --filter @recycle-erp/frontend typecheck`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/components/ImageLightbox.tsx
git commit -m "feat(ui): add shared ImageLightbox component"
```

---

## Task 4: Mobile — plumb `scanImageUrl` and render thumbnail

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx` (`startEdit`, ~lines 208–230)
- Modify: `apps/frontend/src/pages/SubmitForm.tsx`

- [ ] **Step 1: Carry `scanImageUrl` into the edit DraftLine**

In `apps/frontend/src/MobileApp.tsx`, inside `startEdit`, find the `o.lines.map(l => ({ ... }))` block. Locate:

```ts
        scanImageId: l.scanImageId,
        scanConfidence: l.scanConfidence,
```

Change to:

```ts
        scanImageId: l.scanImageId,
        scanConfidence: l.scanConfidence,
        scanImageUrl: l.scanImageUrl,
```

- [ ] **Step 2: Import `ImageLightbox` and add state in `SubmitForm`**

In `apps/frontend/src/pages/SubmitForm.tsx`, the first import line is:

```ts
import { useState } from 'react';
```

Directly below the existing imports (after the `import type { Category, DraftLine, ScanResponse } from '../lib/types';` line), add:

```ts
import { ImageLightbox } from '../components/ImageLightbox';
```

Then, inside the `SubmitForm` component body, immediately after this existing line:

```ts
  const [line, setLine] = useState<DraftLine>(initial);
```

add:

```ts
  const [lightbox, setLightbox] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);

  const scanUrl = existingLine?.scanImageUrl ?? null;
  const showThumb =
    isEditing &&
    !!scanUrl &&
    !scanUrl.startsWith('data:image/placeholder') &&
    !thumbBroken;
```

- [ ] **Step 3: Render the thumbnail below the AI banner**

In `SubmitForm.tsx`, find the AI banner block:

```tsx
        {aiFilled && (
          <div className="ph-ai-banner" style={{ borderRadius: 12, marginTop: 6 }}>
            <span className="pill-ai">AI</span>
            <span>{t('extractedConf', { pct: Math.round((detected!.confidence) * 100) })}</span>
            <Icon name="sparkles" size={13} style={{ marginLeft: 'auto' }} />
          </div>
        )}
```

Immediately AFTER that closing `)}`, add:

```tsx
        {showThumb && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={() => setLightbox(true)}
              style={{
                width: 72,
                height: 72,
                borderRadius: 12,
                border: '1px solid var(--border)',
                overflow: 'hidden',
                padding: 0,
                background: 'var(--bg-soft)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <img
                src={scanUrl!}
                alt={t('aiPhotoLabel')}
                onError={() => setThumbBroken(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </button>
            <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{t('aiPhotoLabel')}</span>
          </div>
        )}
```

- [ ] **Step 4: Render the lightbox at the end of the component**

In `SubmitForm.tsx`, find the final closing of the outer wrapper. The component returns a single `<div className="phone-app">`. Find its closing `</div>` followed by `  );` at the end of the JSX (the last `</div>` before `  );` that closes the `return`). Immediately BEFORE that final closing `</div>`, add:

```tsx
      {lightbox && scanUrl && (
        <ImageLightbox url={scanUrl} alt={t('aiPhotoLabel')} onClose={() => setLightbox(false)} />
      )}
```

- [ ] **Step 5: Add the `aiPhotoLabel` i18n key**

Run: `grep -n "extractedConf" apps/frontend/src/lib/i18n.tsx`
This shows where translation keys live (two locale objects, `en` and `zh`). For EACH locale block, find the line containing `extractedConf:` and add a sibling key immediately after it:

- In the English block, after the `extractedConf` entry, add:
  ```ts
    aiPhotoLabel: 'AI photo',
  ```
- In the Chinese block, after the `extractedConf` entry, add:
  ```ts
    aiPhotoLabel: 'AI 照片',
  ```

(Match the exact punctuation/comma style of the surrounding lines in each block — some use trailing commas, mirror the neighbors.)

- [ ] **Step 6: Typecheck the frontend**

Run: `pnpm --filter @recycle-erp/frontend typecheck`
Expected: exits 0, no errors. If `t('aiPhotoLabel')` errors because the i18n type is a strict union, confirm Step 5 added the key to BOTH locale objects.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/MobileApp.tsx apps/frontend/src/pages/SubmitForm.tsx apps/frontend/src/lib/i18n.tsx
git commit -m "feat(mobile): AI scan photo thumbnail + lightbox in line edit"
```

---

## Task 5: Desktop — extend `Line`, copy scan fields, render thumbnail in `LineDrawer`

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` (`Line` type ~line 136; `LineDrawer` ~lines 525–604)
- Modify: `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` (`orderLineToEditLine` ~lines 566–584)

- [ ] **Step 1: Add scan fields to the `Line` type**

In `apps/frontend/src/pages/desktop/DesktopSubmit.tsx`, find the `Line` type. Its last fields are:

```ts
  sellPrice?: number | string;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
};
```

Change to:

```ts
  sellPrice?: number | string;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
  scanImageId?: string | null;
  scanImageUrl?: string | null;
};
```

(`EditLine` in `DesktopEditOrder.tsx` is `Line & {...}`, so it inherits these automatically — no change to the `EditLine` declaration needed.)

- [ ] **Step 2: Copy scan fields in `orderLineToEditLine`**

In `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx`, find `orderLineToEditLine`. It ends with:

```ts
    qty:            l.qty,
    unitCost:       l.unitCost,
    sellPrice:      l.sellPrice ?? undefined,
  };
}
```

Change to:

```ts
    qty:            l.qty,
    unitCost:       l.unitCost,
    sellPrice:      l.sellPrice ?? undefined,
    scanImageId:    l.scanImageId ?? undefined,
    scanImageUrl:   l.scanImageUrl ?? undefined,
  };
}
```

- [ ] **Step 3: Import `ImageLightbox` and add state in `LineDrawer`**

In `apps/frontend/src/pages/desktop/DesktopSubmit.tsx`, add to the import section (top of file, alongside the other component imports — find the line importing `Icon`, e.g. `import { Icon } from '../../components/Icon';`, and add directly below it):

```ts
import { ImageLightbox } from '../../components/ImageLightbox';
```

Then verify the relative path is correct:
Run: `ls apps/frontend/src/components/ImageLightbox.tsx`
Expected: the file is listed. `DesktopSubmit.tsx` is at `apps/frontend/src/pages/desktop/`, so `../../components/ImageLightbox` resolves to `apps/frontend/src/components/ImageLightbox`. If the existing `Icon` import uses a different number of `../`, mirror that exact prefix instead.

Inside the `LineDrawer` function body, find:

```ts
  const cat = line.category;
  const set = (patch: Partial<Line>) => onChange(patch);
```

Immediately after those two lines, add:

```ts
  const [lightbox, setLightbox] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const scanUrl = line.scanImageUrl ?? null;
  const showThumb =
    !!scanUrl &&
    !scanUrl.startsWith('data:image/placeholder') &&
    !thumbBroken;
```

Confirm `useState` is already imported in this file:
Run: `grep -n "import { useState" apps/frontend/src/pages/desktop/DesktopSubmit.tsx | head -1`
Expected: a match (the file uses `useState` extensively). If `useState` is imported via a combined `import { useMemo, useState } from 'react'`-style line, no change needed.

- [ ] **Step 4: Render the thumbnail tile in the drawer header**

In `LineDrawer` (DesktopSubmit.tsx), find the 56×56 category-icon tile in the header:

```tsx
            <div style={{
              width: 56, height: 56, borderRadius: 8,
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)',
              flexShrink: 0,
            }}>
              <Icon name={cat === 'RAM' ? 'chip' : cat === 'SSD' ? 'drive' : 'box'} size={20} />
            </div>
```

Immediately AFTER that closing `</div>`, add the photo tile:

```tsx
            {showThumb && (
              <button
                type="button"
                onClick={() => setLightbox(true)}
                title="View AI photo"
                style={{
                  width: 56, height: 56, borderRadius: 8,
                  border: '1px solid var(--border)', overflow: 'hidden',
                  padding: 0, background: 'var(--bg-elev)',
                  cursor: 'pointer', flexShrink: 0,
                }}
              >
                <img
                  src={scanUrl!}
                  alt="AI photo"
                  onError={() => setThumbBroken(true)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </button>
            )}
```

- [ ] **Step 5: Render the lightbox inside the drawer**

In `LineDrawer`, the outer element is the fixed backdrop `<div style={{ position: 'fixed', inset: 0, ... }} onClick={onClose}>`. Find the matching closing `</div>` for that outermost backdrop (the last `</div>` before the component's closing `  );`). Immediately BEFORE that final closing `</div>`, add:

```tsx
      {lightbox && scanUrl && (
        <ImageLightbox url={scanUrl} alt="AI photo" onClose={() => setLightbox(false)} />
      )}
```

(`ImageLightbox` uses `position: fixed` with `zIndex: 100`, so it renders above the drawer's `zIndex: 80` regardless of DOM nesting.)

- [ ] **Step 6: Typecheck the frontend**

Run: `pnpm --filter @recycle-erp/frontend typecheck`
Expected: exits 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSubmit.tsx apps/frontend/src/pages/desktop/DesktopEditOrder.tsx
git commit -m "feat(desktop): AI scan photo tile + lightbox in LineDrawer"
```

---

## Task 6: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the stack**

Run (two terminals or background): `pnpm --filter @recycle-erp/backend dev` and `pnpm --filter @recycle-erp/frontend dev`
Expected: backend on :8787, Vite dev server prints a local URL.

- [ ] **Step 2: Mobile — line with a real scan**

In a phone-sized viewport: log in as a purchaser → open an order that has a camera-captured (RAM) line → tap into the review screen → tap a scanned line to open `SubmitForm`. Confirm: a 72×72 thumbnail with an "AI photo" label renders below the AI banner. Tap it → full-screen lightbox opens. Verify close works via the X button, backdrop click, and the Esc key. Expected: all three close the viewer.

- [ ] **Step 3: Mobile — line with no scan**

Edit a manually-entered or `Other`-category line (no scan). Expected: no thumbnail, no console errors.

- [ ] **Step 4: Mobile — dev-stub placeholder**

If running without `CF_ACCOUNT_ID`/`CF_IMAGES_TOKEN`, submit a fresh RAM scan, then edit that line. Expected: no thumbnail (the `data:image/placeholder…` URL is filtered).

- [ ] **Step 5: Desktop — line with a real scan**

In a desktop viewport as a manager: open Orders → click an order's edit action → in `DesktopEditOrder`, click a line row backed by a real scan to open the `LineDrawer`. Expected: a 56×56 photo tile appears in the drawer header next to the category icon. Click it → lightbox opens ABOVE the drawer. Verify X / backdrop / Esc close it.

- [ ] **Step 6: Desktop — line with no scan**

In the same editor, open the drawer for a manual/`Other` line. Expected: no photo tile, no console errors.

- [ ] **Step 7: Broken image**

In the DB, set a known line's `scan_image_id` to a value with no matching `label_scans` row (or an invalid one), reload the edit page, open that line. Expected: thumbnail does not render (JOIN returns NULL) — or, if a stale URL 404s, the `onError` handler hides the thumbnail and closes the lightbox.

- [ ] **Step 8: Final commit (only if verification surfaced fixes)**

If any step required code changes, commit them with a descriptive message. Otherwise this task is complete with no commit.

---

## Self-Review

**Spec coverage:**
- Backend JOIN + `scanImageUrl` → Task 1 ✓
- Frontend types (`OrderLine`, `DraftLine`) → Task 2 ✓
- Shared `ImageLightbox` (backdrop, X, Esc, backdrop-click, onError) → Task 3 ✓
- Mobile plumb + thumbnail + lightbox, placeholder filter, onError hide → Task 4 ✓
- Desktop `Line` extension, `orderLineToEditLine` copy, `LineDrawer` tile + lightbox → Task 5 ✓
- Edge cases (no scan, stub placeholder, broken image, re-scan coexistence) → Tasks 4–6 ✓
- Out-of-scope items (DesktopOrders expanded row, DesktopSubmit new-order flow) → not implemented, by design ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step has full content.

**Type consistency:** `scanImageUrl` is `string | null` on `OrderLine`, `string | null | undefined` (optional) on `DraftLine` and desktop `Line`; `orderLineToEditLine` maps `?? undefined` consistent with its sibling fields. `scanUrl`/`showThumb`/`thumbBroken`/`lightbox` names are consistent within each component. `ImageLightbox` prop names (`url`, `alt`, `onClose`) match all call sites.
