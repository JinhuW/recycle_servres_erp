// Thumbnails of label scans for the packing list, where every PO line's row
// shows its lot so a picker can match the box by eye (user-requested
// 2026-10-07).
//
// Fetched from the scan's public delivery_url, not from R2 by key: dev's
// database is a nightly copy of prod, so its keys name the prod bucket, which
// dev's credentials can't read — the public URL resolves on both. Only
// routes/scan.ts writes that column, from R2_ATTACHMENTS_PUBLIC_URL.
//
// Best-effort throughout: a photo that is missing, slow, oversized or not a
// raster leaves its cell blank and never fails the download.
import sharp from 'sharp';

import { allLimited } from './concurrency';
import { MAX_INPUT_PIXELS } from './image-shrink';
import { log } from './log';
import { createSemaphore } from './semaphore';

// `width`/`height` are the size to show it at; the bytes are twice that, so
// the picture stays sharp on paper.
export type ScanThumb = { buffer: Buffer; width: number; height: number };

// A big order exports a few seconds slower, never times out: past the cap or
// the batch deadline the rest of its rows ship without a photo.
const MAX_PHOTOS = 200;
const FETCH_TIMEOUT_MS = 8_000;
const BATCH_DEADLINE_MS = 20_000;
const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const SHOW_PX = 56;
// sharp renders SVG too; only camera and screenshot formats are scans.
const RASTER = new Set(['jpeg', 'png', 'webp']);

// Decodes pin memory, so they share one process-wide lane, as image-shrink's
// re-encodes do: two managers exporting at once must not run eight.
const runResize = createSemaphore(2, BATCH_DEADLINE_MS, () => new Error('thumbnail lane busy'));

async function thumbnail(url: string, signal: AbortSignal): Promise<ScanThumb | null> {
  const res = await fetch(url, { redirect: 'error', signal });
  if (!res.ok) return null;
  if (Number(res.headers.get('content-length') ?? 0) > MAX_SCAN_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_SCAN_BYTES) return null;
  return runResize(async () => {
    const img = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });
    const { format } = await img.metadata();
    if (!format || !RASTER.has(format)) return null;
    const { data, info } = await img
      .rotate()
      .resize(SHOW_PX * 2, SHOW_PX * 2, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer({ resolveWithObject: true });
    const scale = SHOW_PX / Math.max(info.width, info.height);
    return {
      buffer: data,
      width: Math.max(1, Math.round(info.width * scale)),
      height: Math.max(1, Math.round(info.height * scale)),
    };
  });
}

export async function loadScanThumbnails(urls: readonly string[]): Promise<Map<string, ScanThumb>> {
  const wanted = [...new Set(urls)].filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_PHOTOS);
  const out = new Map<string, ScanThumb>();
  if (wanted.length === 0) return out;

  const deadline = AbortSignal.timeout(BATCH_DEADLINE_MS);
  let failed = 0;
  await allLimited(wanted.map((url) => async () => {
    try {
      const thumb = deadline.aborted
        ? null
        : await thumbnail(url, AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), deadline]));
      if (thumb) out.set(url, thumb);
      else failed++;
    } catch {
      failed++;
    }
  }));
  if (failed > 0) log.warn('packing-list photos unavailable', { failed, total: wanted.length });
  return out;
}
