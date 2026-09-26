// Browser half of the "Scan RAM sheet" flow (RS-109): decode the scanned
// page, find the sticks with the shared pure segmenter, and cut one upright
// JPEG per stick from the full-resolution image for /api/scan/label.

import {
  padSheetBox,
  segmentRamSheet,
  SEGMENT_TARGET_LONG_SIDE,
  type SheetBox,
} from '@recycle-erp/shared';

// A 300 dpi DIMM crop is ~1650 px long; the cap only bites on oversized
// uploads, and keeps each crop well under the upload limit.
const MAX_CROP_LONG_SIDE = 2400;

export type SheetCrop = {
  box: SheetBox;
  blob: Blob;
};

export type SplitSheet = {
  crops: SheetCrop[];
  width: number;
  height: number;
};

export async function splitSheet(file: Blob): Promise<SplitSheet> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = bmp;
    const scale = Math.min(1, SEGMENT_TARGET_LONG_SIDE / Math.max(width, height));
    const small = canvas(Math.round(width * scale), Math.round(height * scale));
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(bmp, 0, 0, small.width, small.height);
    const img = sctx.getImageData(0, 0, small.width, small.height);
    const boxes = segmentRamSheet({ data: img.data, width: img.width, height: img.height });

    const crops: SheetCrop[] = [];
    for (const box of boxes) {
      const b = padSheetBox(box, width, height);
      const sx = Math.round(b.x * width);
      const sy = Math.round(b.y * height);
      const sw = Math.round(b.w * width);
      const sh = Math.round(b.h * height);
      const k = Math.min(1, MAX_CROP_LONG_SIDE / Math.max(sw, sh));
      const dw = Math.round(sw * k);
      const dh = Math.round(sh * k);
      const turned = box.rotate === 90;
      const c = canvas(turned ? dh : dw, turned ? dw : dh);
      const ctx = c.getContext('2d')!;
      if (turned) {
        // Clockwise quarter turn: source (x, y) lands at (dh - y, x).
        ctx.translate(dh, 0);
        ctx.rotate(Math.PI / 2);
      }
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
      crops.push({ box, blob: await toJpeg(c) });
    }
    return { crops, width, height };
  } finally {
    bmp.close();
  }
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function toJpeg(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('crop encode failed'))), 'image/jpeg', 0.9);
  });
}
