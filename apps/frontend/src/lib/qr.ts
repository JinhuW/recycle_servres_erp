// Frame decoding for the serial-number QR scanner.
//
// Native BarcodeDetector when the browser ships one (Android Chrome — the
// hardware path, which also reads the DataMatrix / Code 128 symbols some
// module labels carry); otherwise the pure-JS jsQR decoder (iOS Safari has
// no BarcodeDetector). Both resolve lazily so nothing is downloaded until a
// scanner actually opens.
//
// Both paths decode a centered square CROP of the frame, at native camera
// resolution — module QR codes are tiny (~10 mm), and decoding the whole
// frame downscaled left them a few dozen pixels wide, which no decoder can
// read. The crop matches (slightly over-covers) the on-screen viewfinder
// square, so "fits in the box" is also "what gets decoded".

type NativeDetector = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => NativeDetector;
  }
}

export type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

// Fraction of the frame's shorter side the decode crop covers. The visual
// viewfinder square is drawn a touch smaller, so codes just outside the box
// still catch.
const CROP = 0.72;

function cropFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): boolean {
  if (!video.videoWidth) return false;
  const side = Math.floor(Math.min(video.videoWidth, video.videoHeight) * CROP);
  const sx = Math.floor((video.videoWidth - side) / 2);
  const sy = Math.floor((video.videoHeight - side) / 2);
  // Cap the output: past ~1100px jsQR's per-frame cost outruns the scan loop
  // on mid-range phones, with no accuracy left to gain.
  const out = Math.min(side, 1100);
  canvas.width = out;
  canvas.height = out;
  ctx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
  return true;
}

export async function createFrameDecoder(): Promise<FrameDecoder> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return async () => null;

  if (window.BarcodeDetector) {
    try {
      const det = new window.BarcodeDetector({
        formats: ['qr_code', 'data_matrix', 'code_128'],
      });
      return async (video) => {
        if (!cropFrame(video, canvas, ctx)) return null;
        try {
          const hits = await det.detect(canvas);
          return hits[0]?.rawValue?.trim() || null;
        } catch {
          return null;
        }
      };
    } catch {
      // Format set unsupported — fall through to jsQR.
    }
  }
  const { default: jsQR } = await import('jsqr');
  return async (video) => {
    if (!cropFrame(video, canvas, ctx)) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return hit?.data.trim() || null;
  };
}
