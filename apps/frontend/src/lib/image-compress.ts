// Client-side label-scan compression. We capture at high resolution for OCR
// sharpness, then downscale + re-encode with Squoosh's MozJPEG codec
// (@jsquash/jpeg) before upload — far better quality-per-byte than the
// browser's native canvas encoder, keeping scans well under the 10 MB cap.

const MAX_EDGE = 2560; // ample for label OCR; 4K frames downscale to this
const QUALITY = 75; // MozJPEG quality

/** Fit (w, h) within a max long edge, scaling down only — never up. */
export function fitWithin(
  w: number,
  h: number,
  max = MAX_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(w, h);
  if (longEdge <= max) return { width: w, height: h };
  const scale = max / longEdge;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/**
 * Decode, downscale (if needed), and MozJPEG-encode an image for upload.
 * Returns an `image/jpeg` Blob. Degrades gracefully: if the WASM codec can't
 * load (old browser, offline first paint) it falls back to the browser's
 * native encoder on the already-resized canvas; if the input isn't a
 * decodable image it's returned untouched for the backend to reject.
 */
export async function compressForUpload(input: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input);
  } catch {
    return input;
  }

  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return input;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  try {
    const imageData = ctx.getImageData(0, 0, width, height);
    // encode subpath only — we decode via createImageBitmap, so pulling the
    // decoder WASM too would be ~166 KB of dead weight.
    const { default: encode } = await import('@jsquash/jpeg/encode');
    const buf = await encode(imageData, { quality: QUALITY });
    return new Blob([buf], { type: 'image/jpeg' });
  } catch {
    return await new Promise<Blob>(res =>
      canvas.toBlob(b => res(b ?? input), 'image/jpeg', 0.8),
    );
  }
}
