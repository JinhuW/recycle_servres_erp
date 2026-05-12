# AI scan image preview in order-line edit (mobile + desktop)

**Date:** 2026-05-12
**Status:** Approved — ready for implementation plan

## Problem

When a purchaser submits an order line via camera-OCR, the original photo is uploaded to Cloudflare Images and its `cf_image_id` is persisted on the order line as `scan_image_id`. The `delivery_url` for that image is stored separately in the `label_scans` table.

Today, neither shell surfaces this image back to the user after submission. When a purchaser later edits a submitted line on mobile, or a manager opens a line for review on desktop, they cannot verify what the AI actually saw — they only see the extracted fields. The image is effectively write-only.

This breaks the audit loop: incorrect extractions look indistinguishable from correct ones once the field values are saved.

## Goal

Give the line editor — on both phone and desktop — a one-tap way to view the original AI-extracted photo that backs the line, when one exists.

## Non-goals

- Showing the image during the new-line submission flow (camera → form). The current AI banner with confidence already covers that path; this spec is about *post-submit* review.
- Showing the image on the desktop expanded-row inline table in `DesktopOrders.tsx`. Out of scope per user direction — only the LineDrawer (product-detail panel) gets the affordance.
- Image rotation, zoom-to-pinch, download, share, or replace. The viewer is read-only.
- Backfilling URLs for older scans whose Cloudflare Images variants have been deleted.

## Architecture

```
GET /api/orders/:id  ──▶ LEFT JOIN label_scans
                          adds `scanImageUrl` to every line
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        ▼                                                   ▼
  MOBILE                                              DESKTOP
  Orders → edit                                       DesktopEditOrder
    → review → SubmitForm                             click row → LineDrawer
   thumbnail near AI banner                           thumbnail in drawer header
        └──────────┐                       ┌──────────┘
                   ▼                       ▼
            <ImageLightbox> — shared full-screen viewer
```

One backend query change feeds both shells. A small shared lightbox component handles the full-screen view. Each shell renders a thumbnail in its existing line-edit surface and opens the lightbox on tap.

## Backend

### `apps/backend/src/routes/orders.ts` — `GET /api/orders/:id`

Change the lines query from:

```sql
SELECT id, category, brand, ..., scan_image_id, scan_confidence, position
FROM order_lines
WHERE order_id = ${id}
ORDER BY position ASC
```

to:

```sql
SELECT ol.id, ol.category, ol.brand, ..., ol.scan_image_id, ol.scan_confidence, ol.position,
       ls.delivery_url AS scan_image_url
FROM order_lines ol
LEFT JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
WHERE ol.order_id = ${id}
ORDER BY ol.position ASC
```

LEFT JOIN — not all lines have a scan (manual entries, `Other` category, pre-camera-flow legacy lines).

Include `scanImageUrl: l.scan_image_url` in the line mapper. No change to `apps/backend/src/types.ts`; the return shape is route-local.

The dev-stub `delivery_url` (`data:image/placeholder;name=…`) is returned as-is and filtered out client-side — keeping the backend simple and explicit about what it serves.

### `GET /api/orders/` (list endpoint)

No change. The list view doesn't need the image URL.

## Frontend types — `apps/frontend/src/lib/types.ts`

Add to the order-line interface that `api.get('/api/orders/:id')` returns:

```ts
scanImageUrl?: string | null;
```

Add the same field to `DraftLine` (mobile edit state). Already has `scanImageId` and `scanConfidence`; this slots alongside them.

## Shared component — `apps/frontend/src/components/ImageLightbox.tsx` (new)

A small (~40-line) full-screen image viewer. Props:

```ts
type Props = {
  url: string;
  alt?: string;
  onClose: () => void;
};
```

Behavior:
- Fixed-position backdrop (`rgba(0, 0, 0, 0.85)`), `z-index: 100` (above the desktop LineDrawer's 80).
- Centered `<img>` with `max-width: 92vw`, `max-height: 92vh`, `object-fit: contain`.
- Close affordances: top-right X button, click on backdrop (not the image), Esc key.
- `onError` on the `<img>` → calls `onClose` so a broken URL doesn't leave the user staring at a black screen.
- No external CSS needed — inline styles are fine.

## Mobile

### `apps/frontend/src/MobileApp.tsx` — `startEdit`

Copy `l.scanImageUrl` onto each DraftLine alongside the existing `scanImageId`/`scanConfidence` plumbing. Single-line addition in the existing `o.lines.map(...)`.

### `apps/frontend/src/pages/SubmitForm.tsx`

Conditionally render a thumbnail block when:

```ts
isEditing
  && existingLine?.scanImageUrl
  && !existingLine.scanImageUrl.startsWith('data:image/placeholder')
```

Placement: directly below the existing AI banner block (the one gated by `aiFilled`, around lines 142–149). The thumbnail is on its own row independent of the banner — so it renders whether or not there's a fresh re-scan in progress. Order from top to bottom on the form: AI banner (if `aiFilled`), then thumbnail (if conditions above met), then `<PhCategoryFields>`.

UI:
- ~72×72 rounded card (`border-radius: 12`), `border: 1px solid var(--border)`, `object-fit: cover`.
- A small leading label ("AI photo" — new i18n key added, e.g. `aiPhotoLabel`).
- Tap → opens `<ImageLightbox url={existingLine.scanImageUrl} onClose={...} />`.
- `onError` on `<img>` hides the thumbnail (set local `useState` flag).

When the user re-scans during edit (both `detected` and `existingLine.scanImageUrl` are present), both render — the banner shows the new scan's confidence; the thumbnail shows the originally-saved image. This is intentional; no special-casing needed.

## Desktop

### `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` — `EditLine`

Extend the `EditLine` type with:

```ts
scanImageId?: string | null;
scanImageUrl?: string | null;
```

In `orderLineToEditLine`, copy both fields:

```ts
scanImageId:  l.scanImageId ?? undefined,
scanImageUrl: l.scanImageUrl ?? undefined,
```

`editLineToPatch` and `editLineToInsert` do NOT need the URL — only `id`, status, and the editable fields go to PATCH. The image fields are read-only display state on the client.

### `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — `Line` type + `LineDrawer`

Extend the exported `Line` type with the same two optional fields (since `EditLine` extends `Line` via the import).

Inside `LineDrawer`, in the header row (around line 564 — the row containing the index tile and category-icon tile), conditionally render a third tile when:

```ts
line.scanImageUrl && !line.scanImageUrl.startsWith('data:image/placeholder')
```

The tile:
- 56×56 to match the existing category icon tile
- `border-radius: 8`, `border: 1px solid var(--border)`, `overflow: hidden`
- `<img src={line.scanImageUrl}>` with `object-fit: cover`
- `cursor: pointer`, on click opens `<ImageLightbox>`
- `onError` hides via local `useState`

DesktopSubmit's new-order flow is unaffected — its lines have no `scanImageUrl` so nothing renders.

## Edge cases

| Scenario | Behavior |
|---|---|
| Manual entry, no scan | `scan_image_id` is NULL → JOIN returns NULL URL → thumbnail not rendered |
| `Other` category, no scan | Same as above |
| Dev-stub placeholder URL | Filtered by `startsWith('data:image/placeholder')` → not rendered |
| Cloudflare image deleted (404) | `<img>` `onError` fires → thumbnail hidden silently; if lightbox open, it closes |
| Re-scan during edit | AI banner + thumbnail both visible — banner = new scan, thumbnail = original |
| User navigates away with lightbox open | Component unmounts cleanly; Esc handler is removed in cleanup |

## Files touched

1. `apps/backend/src/routes/orders.ts` — JOIN + return URL
2. `apps/frontend/src/lib/types.ts` — add `scanImageUrl` to OrderLine + DraftLine
3. `apps/frontend/src/components/ImageLightbox.tsx` — new shared viewer
4. `apps/frontend/src/MobileApp.tsx` — plumb in `startEdit`
5. `apps/frontend/src/pages/SubmitForm.tsx` — thumbnail + lightbox trigger
6. `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` — extend EditLine, copy in conversion
7. `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — extend Line type, render tile + lightbox in LineDrawer

## Testing notes

Manual test plan (no automated tests exist for these flows currently):

- **Mobile, line with scan:** Orders → tap an order with a camera-captured line → tap a line in the review screen → SubmitForm shows the thumbnail → tap → lightbox opens → close via X, backdrop, and Esc all work.
- **Mobile, manual entry:** Submit an Other-category line manually → edit it → no thumbnail rendered, no console errors.
- **Mobile, dev-stub:** Run without `CF_*` env vars → submit a RAM scan → edit the line → no thumbnail (placeholder filtered).
- **Desktop, line with scan:** DesktopEditOrder → click a row backed by a real scan → LineDrawer opens with the photo tile → click tile → lightbox above drawer → close paths all work.
- **Desktop, line without scan:** Edit a manual line → drawer has no photo tile.
- **Broken image:** Manually invalidate a `cf_image_id` in DB → reload edit page → thumbnail does not render (or disappears on load error).
