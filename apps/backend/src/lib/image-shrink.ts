// Server-side downscale for oversized image uploads. Phone screenshots and
// photos routinely exceed the workspace upload cap; rejecting them with 413
// made receipt capture unusable, so images are re-encoded to fit instead.
// Strictly best-effort like the receipt renamer: any decode/encode problem
// returns the original file and the route's existing size check decides.
import sharp from 'sharp';

const SHRINKABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

// Each pass scales dimensions down and (for lossy formats) lowers quality;
// byte size falls roughly with the pixel count, so a handful of passes covers
// any realistic camera output.
const MAX_PASSES = 6;
const SCALE_STEP = 0.7;

export async function shrinkImageToFit(file: File, maxBytes: number): Promise<File> {
  if (file.size <= maxBytes || !SHRINKABLE.has(file.type)) return file;

  try {
    const input = Buffer.from(await file.arrayBuffer());
    // .rotate() bakes in EXIF orientation — resizing strips metadata, and a
    // sideways receipt would defeat both the OCR rename and the reader.
    const meta = await sharp(input).rotate().metadata();
    if (!meta.width || !meta.height) return file;

    let scale = Math.min(1, Math.sqrt(maxBytes / file.size));
    let quality = 80;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const pipeline = sharp(input).rotate().resize({
        width: Math.max(1, Math.round(meta.width * scale)),
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
  } catch {
    return file;
  }
  return file;
}
