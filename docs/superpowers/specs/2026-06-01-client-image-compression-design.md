# Client-side image compression for label scans (Squoosh / MozJPEG)

**Date:** 2026-06-01
**Status:** Approved — ready for implementation plan

## Problem

The in-app camera (`Camera.tsx`) now captures at high resolution (4K
`getUserMedia` hint), which fixed the OCR clarity gap versus the native
file-picker path. But a 4K frame encoded with the browser's native
`canvas.toBlob(…, 0.85)` is a large upload, and native-camera photos can be
5–10 MB+, brushing the backend's 10 MB cap. We want smaller uploads without
sacrificing the label-text sharpness that OCR depends on.

## Goal

Compress every scan image **client-side** with Squoosh's MozJPEG codec before
it hits `/api/scan/label`, capping resolution at a long edge of ~2560 px.
Smaller, sharper-per-byte uploads; no backend change.

## Decisions

- **Codec / format:** MozJPEG via `@jsquash/jpeg` (the maintained,
  browser-usable extraction of Squoosh's codecs; `@squoosh/lib` is Node-only
  and archived). Output MIME `image/jpeg`. Encode-only — native
  `createImageBitmap` decodes and canvas does the modest downscale, so only the
  one encoder WASM is bundled.
- **Scope:** both capture paths — the in-app 4K camera frame *and* the native
  file-picker photo — routed through one helper.
- **Resolution:** downscale only when the long edge exceeds 2560 px; never
  upscale. 2560 is ample for label OCR.
- **Quality:** MozJPEG `quality: 75`.

## Components

### New: `apps/frontend/src/lib/image-compress.ts`

```
fitWithin(w: number, h: number, max = 2560): { width: number; height: number }
compressForUpload(input: Blob): Promise<Blob>
```

`compressForUpload`:
1. Decode `input` with `createImageBitmap`.
2. Target size from `fitWithin` (scale down only if long edge > 2560).
3. Draw to a canvas at target size, read `ImageData`.
4. Lazy `import('@jsquash/jpeg')`, `encode(imageData, { quality: 75 })` →
   `image/jpeg` Blob.
5. **Graceful degrade** (WASM can genuinely fail on old browsers / offline):
   on encoder load or encode failure, fall back to
   `canvas.toBlob('image/jpeg', 0.8)` on the already-resized canvas. The upload
   always gets a resized, compressed JPEG — never the raw multi-MB original.

`fitWithin` is the pure, unit-testable core (the only part runnable under
jsdom); it gets a small test per the CLAUDE.md "non-trivial pure helper" rule.

### Wiring: `apps/frontend/src/pages/Camera.tsx`

- `onShoot`: when the live camera produced a frame, pass the captured blob
  through `compressForUpload` before `runScan`; the frozen preview uses the
  compressed blob. The no-camera placeholder-PNG path is left untouched.
- `onFileChosen`: pass the picked file through `compressForUpload` before
  `runScan`; filename becomes `label.jpg`.
- No new phase — compression runs within the existing `capturing` step,
  before `scanning`.

### Vite: `apps/frontend/vite.config.ts`

Add `optimizeDeps.exclude: ['@jsquash/jpeg']` (the known Vite + jSquash WASM
gotcha). Verify with a real `pnpm build`.

## Out of scope / no change

- **Backend & Cloudflare:** none. `image/jpeg` is already in
  `SAFE_UPLOAD_MIME`; `/api/scan/label` already persists to R2 and feeds the
  OpenRouter OCR provider.
- AVIF / WebP (AVIF isn't in the safe MIME set; WebP was considered but
  MozJPEG chosen for compatibility).

## Testing

- Unit-test `fitWithin` (downscale ratio, no-upscale, square/portrait/landscape,
  exact-boundary cases).
- `compressForUpload` (canvas + WASM) is verified manually on a device: scan a
  RAM label with the in-app camera and via file-picker, confirm the uploaded
  image is JPEG, ≤ ~2560 px long edge, well under 10 MB, and OCR confidence
  matches the native-upload baseline.
- `pnpm --filter recycle-erp-frontend typecheck` and `pnpm build` pass.
