import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import {
  findRamStickInPhoto,
  padSheetBox,
  padStickBox,
  segmentRamSheet,
  SEGMENT_TARGET_LONG_SIDE,
  type RasterImage,
} from '@recycle-erp/shared';

// The flatbed "Scan RAM sheet" flow (RS-109) splits one scanned page into a
// crop per stick in the browser. The segmenter is pure TS over raw pixels so
// it can be pinned here against real scans, decoded by sharp exactly as the
// browser's canvas would hand them over (RGBA, downsampled).

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function load(name: string): Promise<RasterImage> {
  const { data, info } = await sharp(fixture(name))
    .resize({
      width: SEGMENT_TARGET_LONG_SIDE,
      height: SEGMENT_TARGET_LONG_SIDE,
      fit: 'inside',
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

type Rect = { x: number; y: number; w: number; h: number };
const GREEN: [number, number, number] = [40, 120, 60];

function synth(width: number, height: number, rects: Rect[], bands: Rect[] = []): RasterImage {
  const data = new Uint8Array(width * height * 3).fill(250);
  const paint = (r: Rect, rgb: [number, number, number]) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        data.set(rgb, (y * width + x) * 3);
      }
    }
  };
  rects.forEach(r => paint(r, GREEN));
  bands.forEach(r => paint(r, [255, 255, 255]));
  return { data, width, height, channels: 3 };
}

describe('segmentRamSheet — real scans', () => {
  it('finds the two sticks in the sample scan, Samsung first', async () => {
    const boxes = segmentRamSheet(await load('ram-sheet-2.jpeg'));
    expect(boxes).toHaveLength(2);
    const [samsung, dimm] = boxes;
    // Reading order: the short SODIMM sits left of the long RDIMM even though
    // the RDIMM's top edge is higher on the page.
    expect(samsung.x + samsung.w).toBeLessThan(dimm.x);
    expect(dimm.h).toBeGreaterThan(samsung.h * 1.4);
    for (const b of boxes) {
      expect(b.rotate).toBe(90);
      expect(b.maybeMerged).toBe(false);
    }
  });

  it('ignores the lid-edge lines in a live 300 dpi scan', async () => {
    const boxes = segmentRamSheet(await load('ram-sheet-live.jpeg'));
    expect(boxes).toHaveLength(2);
    // Neither box runs along the page edge.
    for (const b of boxes) {
      expect(b.w).toBeLessThan(0.5);
      expect(b.x).toBeGreaterThan(0.02);
      expect(b.y).toBeGreaterThan(0.02);
    }
  });
});

describe('segmentRamSheet — synthetic pages', () => {
  it('returns nothing for a blank page', () => {
    expect(segmentRamSheet(synth(600, 800, []))).toEqual([]);
  });

  it('orders three sticks in two rows by reading order', () => {
    const boxes = segmentRamSheet(
      synth(600, 800, [
        { x: 350, y: 60, w: 200, h: 50 }, // row 1, right
        { x: 50, y: 70, w: 200, h: 50 }, // row 1, left
        { x: 50, y: 400, w: 300, h: 60 }, // row 2
      ]),
    );
    expect(boxes).toHaveLength(3);
    expect(boxes.map(b => Math.round(b.x * 600))).toEqual([50, 350, 50]);
    expect(boxes.every(b => b.rotate === 0)).toBe(true);
  });

  it('flags two sticks lying against each other', () => {
    const boxes = segmentRamSheet(
      synth(600, 800, [
        { x: 100, y: 100, w: 60, h: 300 },
        { x: 160, y: 100, w: 60, h: 300 }, // touching the first
        { x: 400, y: 100, w: 60, h: 300 },
      ]),
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0].maybeMerged).toBe(true);
    expect(boxes[1].maybeMerged).toBe(false);
  });

  it('keeps a stick whole when a white label spans its full width', () => {
    const boxes = segmentRamSheet(
      synth(600, 800, [{ x: 100, y: 100, w: 60, h: 400 }], [{ x: 100, y: 250, w: 60, h: 25 }]),
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0].h * 800).toBeGreaterThan(390);
  });

  it('keeps two parallel sticks with a narrow gap apart', () => {
    const boxes = segmentRamSheet(
      synth(600, 800, [
        { x: 100, y: 100, w: 60, h: 400 },
        { x: 185, y: 100, w: 60, h: 400 },
      ]),
    );
    expect(boxes).toHaveLength(2);
  });

  it('drops dust and thin edge lines', () => {
    const boxes = segmentRamSheet(
      synth(600, 800, [
        { x: 0, y: 0, w: 600, h: 3 }, // lid edge
        { x: 300, y: 600, w: 4, h: 4 }, // speck
        { x: 100, y: 100, w: 200, h: 50 },
      ]),
    );
    expect(boxes).toHaveLength(1);
  });
});

describe('padSheetBox', () => {
  it('grows by the same pixel margin on both axes and clamps to the page', () => {
    const b = padSheetBox({ x: 0, y: 0.5, w: 0.2, h: 0.1, rotate: 0, maybeMerged: false }, 600, 800, 0.02);
    expect(b.x).toBe(0);
    expect(b.w * 600).toBeCloseTo(0.2 * 600 + 12, 5);
    expect(b.y * 800).toBeCloseTo(0.5 * 800 - 12, 5);
    expect(b.h * 800).toBeCloseTo(0.1 * 800 + 24, 5);
  });
});

// Desk scanner (RS-120): one stick on a real desk, found by its green PCB.
// The fixture is Jinhu's Continuity Camera frame — stick on paper, black
// cloth, wooden desk, a hand reaching in.
describe('findRamStickInPhoto', () => {
  const DESK: [number, number, number] = [110, 70, 40];

  function desk(width: number, height: number, sticks: Rect[], bands: Rect[] = []): RasterImage {
    const img = synth(width, height, sticks, bands);
    const data = img.data as Uint8Array;
    for (let i = 0; i < width * height; i++) {
      const p = i * 3;
      if (data[p] === 250 && data[p + 1] === 250 && data[p + 2] === 250) data.set(DESK, p);
    }
    return img;
  }

  // The stick in the 432×322 fixture spans about (133..351, 106..162).
  const expectFixtureStick = (b: ReturnType<typeof findRamStickInPhoto>) => {
    expect(b).not.toBeNull();
    const box = b!;
    expect(box.rotate).toBe(0);
    expect(box.x).toBeGreaterThan(115 / 432);
    expect(box.x).toBeLessThan(140 / 432);
    expect(box.x + box.w).toBeGreaterThan(345 / 432);
    expect(box.x + box.w).toBeLessThan(370 / 432);
    expect(box.y).toBeGreaterThan(90 / 322);
    expect(box.y + box.h).toBeLessThan(180 / 322);
    // The hand is in the bottom third; the box must stay clear of it.
    expect(box.y + box.h).toBeLessThan(0.6);
  };

  it('finds the stick in a real desk frame and leaves out the hand, cloth and desk', async () => {
    expectFixtureStick(findRamStickInPhoto(await load('desk-cam-frame.jpeg')));
  });

  it('gives the same box from a full-resolution frame downsampled as in the browser', async () => {
    const big = await sharp(fixture('desk-cam-frame.jpeg')).resize({ width: 1920 }).toBuffer();
    const { data, info } = await sharp(big)
      .resize({ width: SEGMENT_TARGET_LONG_SIDE, height: SEGMENT_TARGET_LONG_SIDE, fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expectFixtureStick(findRamStickInPhoto({ data, width: info.width, height: info.height, channels: 4 }));
  });

  it('returns null when there is no green stick', () => {
    expect(findRamStickInPhoto(desk(400, 300, []))).toBeNull();
  });

  it('ignores a green speck too small to be a stick', () => {
    expect(findRamStickInPhoto(desk(400, 300, [{ x: 100, y: 100, w: 12, h: 4 }]))).toBeNull();
  });

  it('turns a stick lying vertically', () => {
    expect(findRamStickInPhoto(desk(400, 400, [{ x: 180, y: 40, w: 60, h: 300 }]))?.rotate).toBe(90);
  });

  it('keeps a stick whole when a label spans its full height', () => {
    // 300×60 stick with a 60-px white label across its whole height.
    const b = findRamStickInPhoto(
      desk(400, 300, [{ x: 50, y: 120, w: 300, h: 60 }], [{ x: 170, y: 120, w: 60, h: 60 }]),
    );
    expect(b).not.toBeNull();
    expect(b!.x * 400).toBeLessThan(55);
    expect((b!.x + b!.w) * 400).toBeGreaterThan(345);
  });
});

describe('padStickBox', () => {
  it('pads a frame-filling stick by a quarter of its thickness so the gold fingers survive', () => {
    // 1000×600 frame, 900×200 px stick: 25% of 200 = 50 px beats 4% of 600 = 24.
    const b = padStickBox({ x: 0.05, y: 0.3, w: 0.9, h: 200 / 600, rotate: 0, maybeMerged: false }, 1000, 600);
    expect(b.y * 600).toBeCloseTo(180 - 50, 5);
    expect((b.y + b.h) * 600).toBeCloseTo(380 + 50, 5);
    expect(b.x).toBe(0);
  });

  it('uses 4% of the frame for a small stick', () => {
    const b = padStickBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.05, rotate: 0, maybeMerged: false }, 1000, 1000);
    expect(b.x * 1000).toBeCloseTo(400 - 40, 5);
  });
});
