// Server-side downscale for oversized image uploads. Phone screenshots and
// photos routinely exceed the workspace upload cap; rejecting them with 413
// made receipt capture unusable, so images are re-encoded to fit instead.
// Best-effort by default, like the receipt renamer: any decode/encode problem
// returns the original file and the route's existing size check decides. A
// strict caller (the anonymous intake form) gets a refusal instead.
import sharp from 'sharp';

import { log } from './log';
import { createSemaphore } from './semaphore';

const SHRINKABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

// Each pass scales dimensions down and (for lossy formats) lowers quality;
// byte size falls roughly with the pixel count, so a handful of passes covers
// any realistic camera output.
const MAX_PASSES = 6;
const SCALE_STEP = 0.7;

// A PNG can declare 16k×16k in under a megabyte, and the re-encode then needs
// the whole raster in memory (palette quantisation, ~1 GB for that one) — more
// than the backend's memory cap, from one anonymous upload. 40 MP is well past
// any phone camera, so it is the anonymous (strict) limit. Staff uploads keep
// sharp's own ceiling: a long scrolling screenshot of a chat or a PayPal page,
// filed as payment evidence, can run past 40 MP and has to be shrunk, not
// refused.
export const MAX_INPUT_PIXELS = 40_000_000;
const SHARP_DEFAULT_PIXELS = 0x3fff * 0x3fff;
// Few re-encodes at a time, and anonymous ones in their own lane, so a flood
// through the public form can't make a staff upload wait or fall back.
const runPublicShrink = createSemaphore(2, 30_000, () => new ImageRejectedError('busy'));
const runStaffShrink = createSemaphore(2, 60_000, () => new ImageRejectedError('busy'));

// Why a strict caller's image was refused. Non-strict callers never see it:
// for them every problem falls back to the original file.
export class ImageRejectedError extends Error {
  constructor(readonly reason: 'too_many_pixels' | 'undecodable' | 'busy') {
    super(`image rejected: ${reason}`);
    this.name = 'ImageRejectedError';
  }
}

export type ShrinkOptions = {
  // Refuse (throw ImageRejectedError) instead of passing the original through.
  // For anonymous uploads, where "the route's size check decides" is not a
  // safety net worth having. Also lowers the pixel limit to MAX_INPUT_PIXELS.
  strict?: boolean;
  maxPixels?: number;
};

export async function shrinkImageToFit(
  file: File, maxBytes: number, opts: ShrinkOptions = {},
): Promise<File> {
  if (file.size <= maxBytes || !SHRINKABLE.has(file.type)) return file;
  const strict = opts.strict === true;
  const maxPixels = opts.maxPixels ?? (strict ? MAX_INPUT_PIXELS : SHARP_DEFAULT_PIXELS);
  const run = strict ? runPublicShrink : runStaffShrink;

  try {
    return await run(() => shrink(file, maxBytes, maxPixels, strict));
  } catch (e) {
    if (opts.strict) throw e instanceof ImageRejectedError ? e : new ImageRejectedError('undecodable');
    log.warn('image shrink failed; passing the original through', {
      type: file.type, bytes: file.size, error: e instanceof Error ? e.message : String(e),
    });
    return file;
  }
}

async function shrink(file: File, maxBytes: number, maxPixels: number, strict: boolean): Promise<File> {
  const input = Buffer.from(await file.arrayBuffer());
  // limitInputPixels makes sharp refuse to decode past the cap at all, so a
  // lying header can't get as far as allocating the raster.
  const open = () => sharp(input, { limitInputPixels: maxPixels });
  const meta = await open().metadata();
  if (!meta.width || !meta.height) {
    if (strict) throw new ImageRejectedError('undecodable');
    return file;
  }
  if (meta.width * meta.height > maxPixels) throw new ImageRejectedError('too_many_pixels');
  // .rotate() bakes in EXIF orientation — resizing strips metadata, and a
  // sideways receipt would defeat both the OCR rename and the reader. The
  // metadata is pre-rotation, so a quarter-turned photo's width is its height.
  const width = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;

  let scale = Math.min(1, Math.sqrt(maxBytes / file.size));
  let quality = 80;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const pipeline = open().rotate().resize({
      width: Math.max(1, Math.round(width * scale)),
      withoutEnlargement: true,
    });
    const out = file.type === 'image/png'
      ? await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
      : file.type === 'image/webp'
        ? await pipeline.webp({ quality }).toBuffer()
        : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.byteLength <= maxBytes) {
      return new File([new Uint8Array(out)], file.name, { type: file.type });
    }
    scale *= SCALE_STEP;
    quality = Math.max(40, quality - 10);
  }
  return file;
}
