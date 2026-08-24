// Frame decoding for the serial-number QR scanner.
//
// Native BarcodeDetector when the browser ships one (Android Chrome — the
// hardware path, which also reads the DataMatrix / Code 128 symbols some
// module labels carry); otherwise the pure-JS jsQR decoder (iOS Safari has
// no BarcodeDetector). Both resolve lazily so nothing is downloaded until a
// scanner actually opens.

type NativeDetector = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => NativeDetector;
  }
}

export type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>;

export async function createFrameDecoder(): Promise<FrameDecoder> {
  if (window.BarcodeDetector) {
    try {
      const det = new window.BarcodeDetector({
        formats: ['qr_code', 'data_matrix', 'code_128'],
      });
      return async (video) => {
        try {
          const hits = await det.detect(video);
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
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    if (!ctx || !video.videoWidth) return null;
    // jsQR is O(pixels) and a QR survives 800px wide fine — decoding the
    // full 1080p+ frame would blow the scan-loop budget on mid-range phones.
    const scale = Math.min(1, 800 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return hit?.data.trim() || null;
  };
}
