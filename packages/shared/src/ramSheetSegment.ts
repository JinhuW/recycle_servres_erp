// Split a flatbed scan of several RAM sticks into one box per stick.
//
// The scan is sticks on white paper: the PCB is saturated green, the chips
// are near-black, the labels are white but always *inside* a stick. So a
// "not paper" mask (saturated OR dark) followed by a small morphological
// close and connected components gives one blob per stick — a label only
// punches a hole, it never splits the blob, unless it spans the stick's
// full width, which the box merge below handles.
//
// Pure TS over raw pixels, no DOM and no sharp: the browser feeds it canvas
// ImageData, the backend tests feed it sharp-decoded fixtures. Callers
// should downsample to about SEGMENT_TARGET_LONG_SIDE first — the thresholds
// are relative, but the flood fill is O(pixels).

/** Long side, in px, the caller should downsample the scan to. */
export const SEGMENT_TARGET_LONG_SIDE = 800;

/** Hard cap on sticks per sheet (each one is an AI call). */
export const MAX_SHEET_STICKS = 30;

export interface RasterImage {
  /** Row-major pixels, `channels` bytes each (RGB or RGBA). */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** 3 or 4. Defaults to 4 (canvas ImageData). */
  channels?: 3 | 4;
}

/** One detected stick, in fractions (0–1) of the page. */
export interface SheetBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Clockwise degrees to turn the crop so the stick lies horizontally.
   * Portrait sticks get 90: labels on a stick laid vertically read
   * bottom-to-top, and turning clockwise makes them read left-to-right.
   */
  rotate: 0 | 90;
  /** The blob looks like two or more sticks touching. */
  maybeMerged: boolean;
}

// A pixel is "not paper" when it is visibly colored or dark. Scanner white
// sits at saturation < 0.05 and luma > 200; PCB green is ~0.4 saturation.
const MIN_SATURATION = 0.18;
const MAX_PAPER_LUMA = 170;
// Close radius as a fraction of the page's short side: bridges the gaps
// between chips and the label edge without joining neighbouring sticks.
const CLOSE_FRACTION = 0.012;
// The lid edge shows up as a dark 1–3 px line along the page border; clear a
// thin frame before labelling so it can't bridge into a stick near the edge.
const BORDER_FRACTION = 0.006;
const MIN_AREA_FRACTION = 0.004;
// Also removes the lid-edge lines if they survive the border clear.
const MIN_SHORT_SIDE_FRACTION = 0.03;
// Two boxes that line up along their long axis with only a small gap are one
// stick cut in two (a label spanning the full width).
const MERGE_MIN_OVERLAP = 0.6;
const MERGE_MAX_GAP_OF_SHORT = 0.5;
// DIMM is ~4.3:1 and SODIMM ~2.3:1; a squarer blob, or one much thicker than
// its peers, is almost certainly sticks lying against each other.
const MERGED_MAX_ASPECT = 1.5;
const MERGED_SHORT_SIDE_RATIO = 1.8;

interface PxBox {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

/** Finds the RAM sticks on a scanned sheet, in reading order. */
export function segmentRamSheet(img: RasterImage): SheetBox[] {
  const { width: w, height: h } = img;
  if (w < 8 || h < 8) return [];
  const short = Math.min(w, h);

  let mask = buildMask(img);
  clearBorder(mask, w, h, Math.max(1, Math.round(short * BORDER_FRACTION)));
  const r = Math.max(1, Math.round(short * CLOSE_FRACTION));
  mask = erode(dilate(mask, w, h, r), w, h, r);

  const minArea = MIN_AREA_FRACTION * w * h;
  const minShort = MIN_SHORT_SIDE_FRACTION * short;
  let boxes = components(mask, w, h).filter(
    (c) => c.area >= minArea && Math.min(c.x1 - c.x0, c.y1 - c.y0) >= minShort,
  ) as PxBox[];

  boxes = mergeAligned(boxes);
  if (boxes.length > MAX_SHEET_STICKS) {
    boxes = boxes
      .sort((a, b) => area(b) - area(a))
      .slice(0, MAX_SHEET_STICKS);
  }

  const shorts = boxes.map(shortSide).sort((a, b) => a - b);
  const median = shorts.length ? shorts[Math.floor((shorts.length - 1) / 2)] : 0;

  return readingOrder(boxes).map((b) => {
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);
    return {
      x: b.x0 / w,
      y: b.y0 / h,
      w: bw / w,
      h: bh / h,
      rotate: bh > bw ? 90 : 0,
      maybeMerged:
        aspect < MERGED_MAX_ASPECT ||
        (boxes.length > 1 && shortSide(b) > median * MERGED_SHORT_SIDE_RATIO),
    };
  });
}

/**
 * Grows a box by `pad` (fraction of the page's short side) on every side,
 * clamped to the page. Crops need a margin: the mask edge sits on the PCB
 * edge, and the gold fingers are pale enough to be partly cut.
 */
export function padSheetBox(
  box: SheetBox,
  pageWidth: number,
  pageHeight: number,
  pad = 0.015,
): SheetBox {
  const px = (pad * Math.min(pageWidth, pageHeight)) / pageWidth;
  const py = (pad * Math.min(pageWidth, pageHeight)) / pageHeight;
  const x = Math.max(0, box.x - px);
  const y = Math.max(0, box.y - py);
  return {
    ...box,
    x,
    y,
    w: Math.min(1, box.x + box.w + px) - x,
    h: Math.min(1, box.y + box.h + py) - y,
  };
}

// ── One stick in a desk-camera frame ────────────────────────────────────────
//
// The desk scanner (RS-119) sees a stick on whatever is on the desk — cloth,
// wood, a hand — so "not paper" marks everything. What sets a stick apart
// there is the PCB's green: wood and skin sit at 10–40° hue, dark cloth has no
// value, paper no saturation. Gold fingers (~50°) and the white label fall
// outside the mask; the close fills the label and padStickBox brings the
// fingers back.
const PCB_MIN_HUE = 70;
const PCB_MAX_HUE = 170;
const PCB_MIN_SATURATION = 0.2;
const PCB_MIN_VALUE = 40;
const PHOTO_CLOSE_FRACTION = 0.015;
const PHOTO_MIN_AREA_FRACTION = 0.003;
// A DIMM is ~4.3:1, a SODIMM ~2.3:1; anything squarer isn't a stick lying
// flat (or is tilted too far for an axis-aligned crop to be worth it).
const PHOTO_MIN_ASPECT = 1.8;
// A sheet packs sticks a few mm apart, so it only rejoins halves across a
// narrow gap. On a desk there's one stick, and a DIMM label is often wider
// than the stick is tall — the gap it leaves in the green can be 1.5× that.
const PHOTO_MERGE_MAX_GAP_OF_SHORT = 1.5;

/**
 * The largest green-PCB stick in a camera frame, in fractions of the frame,
 * or null when there's none (non-green PCB, steep tilt, nothing there).
 * Downsample to about SEGMENT_TARGET_LONG_SIDE first, like segmentRamSheet.
 */
export function findRamStickInPhoto(img: RasterImage): SheetBox | null {
  const { width: w, height: h } = img;
  if (w < 8 || h < 8) return null;
  const short = Math.min(w, h);

  const r = Math.max(1, Math.round(short * PHOTO_CLOSE_FRACTION));
  const mask = erode(dilate(buildPcbMask(img), w, h, r), w, h, r);
  const minArea = PHOTO_MIN_AREA_FRACTION * w * h;
  // A label as tall as the stick cuts its green rims in two; the sheet's
  // merge rule rejoins halves that line up along the long axis.
  const boxes = mergeAligned(
    components(mask, w, h).filter((c) => c.area >= minArea),
    PHOTO_MERGE_MAX_GAP_OF_SHORT,
  )
    .filter((b) => {
      const bw = b.x1 - b.x0;
      const bh = b.y1 - b.y0;
      return area(b) >= minArea && Math.max(bw, bh) / Math.min(bw, bh) >= PHOTO_MIN_ASPECT;
    });
  if (!boxes.length) return null;

  const b = boxes.reduce((best, c) => (area(c) > area(best) ? c : best));
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  return {
    x: b.x0 / w,
    y: b.y0 / h,
    w: bw / w,
    h: bh / h,
    rotate: bh > bw ? 90 : 0,
    maybeMerged: false,
  };
}

/**
 * Pads a photo stick box by the larger of 4% of the frame's short side and a
 * quarter of the stick's own thickness, clamped to the frame. The mask stops
 * at the green, and the gold fingers below it are ~12% of the stick's height —
 * a frame-relative pad alone cuts them when the stick fills the frame.
 */
export function padStickBox(box: SheetBox, frameWidth: number, frameHeight: number): SheetBox {
  const stickShortPx = Math.min(box.w * frameWidth, box.h * frameHeight);
  const padPx = Math.max(0.04 * Math.min(frameWidth, frameHeight), 0.25 * stickShortPx);
  const px = padPx / frameWidth;
  const py = padPx / frameHeight;
  const x = Math.max(0, box.x - px);
  const y = Math.max(0, box.y - py);
  return {
    ...box,
    x,
    y,
    w: Math.min(1, box.x + box.w + px) - x,
    h: Math.min(1, box.y + box.h + py) - y,
  };
}

function buildPcbMask(img: RasterImage): Uint8Array {
  const { data, width: w, height: h } = img;
  const ch = img.channels ?? 4;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < PCB_MIN_VALUE || max === min) continue;
    if ((max - min) / max < PCB_MIN_SATURATION) continue;
    const d = max - min;
    let hue: number;
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
    if (hue < 0) hue += 360;
    if (hue >= PCB_MIN_HUE && hue <= PCB_MAX_HUE) mask[i] = 1;
  }
  return mask;
}

function buildMask(img: RasterImage): Uint8Array {
  const { data, width: w, height: h } = img;
  const ch = img.channels ?? 4;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    mask[i] = sat > MIN_SATURATION || luma < MAX_PAPER_LUMA ? 1 : 0;
  }
  return mask;
}

function clearBorder(mask: Uint8Array, w: number, h: number, b: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (y < b || y >= h - b) {
      mask.fill(0, row, row + w);
    } else {
      mask.fill(0, row, row + b);
      mask.fill(0, row + w - b, row + w);
    }
  }
}

// Square-window dilate/erode, separable, O(pixels) via running counts.
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morph(src, w, h, r, 'dilate');
}

function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // Outside the page counts as "set" so the close doesn't eat the edges of a
  // stick lying against the border.
  return morph(src, w, h, r, 'erode');
}

function morph(
  src: Uint8Array,
  w: number,
  h: number,
  r: number,
  mode: 'dilate' | 'erode',
): Uint8Array {
  const span = 2 * r + 1;
  const keep = (count: number): boolean =>
    mode === 'dilate' ? count > 0 : count === span;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const outside = mode === 'erode' ? 1 : 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = -r; x <= r; x++) count += x < 0 || x >= w ? outside : src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = keep(count) ? 1 : 0;
      const drop = x - r;
      const add = x + r + 1;
      count -= drop < 0 ? outside : src[row + drop];
      count += add >= w ? outside : src[row + add];
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y <= r; y++) count += y < 0 || y >= h ? outside : tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = keep(count) ? 1 : 0;
      const drop = y - r;
      const add = y + r + 1;
      count -= drop < 0 ? outside : tmp[drop * w + x];
      count += add >= h ? outside : tmp[add * w + x];
    }
  }
  return out;
}

function components(
  mask: Uint8Array,
  w: number,
  h: number,
): Array<PxBox & { area: number }> {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Array<PxBox & { area: number }> = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    while (top > 0) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, area });
  }
  return out;
}

function mergeAligned(input: PxBox[], maxGapOfShort = MERGE_MAX_GAP_OF_SHORT): PxBox[] {
  const boxes = input.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (shouldMerge(boxes[i], boxes[j], maxGapOfShort)) {
          const a = boxes[i];
          const b = boxes[j];
          boxes[i] = {
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
          };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes;
}

function shouldMerge(a: PxBox, b: PxBox, maxGapOfShort: number): boolean {
  const ox = overlap(a.x0, a.x1, b.x0, b.x1);
  const oy = overlap(a.y0, a.y1, b.y0, b.y1);
  if (ox > 0 && oy > 0) return true; // boxes intersect
  const minShort = Math.min(shortSide(a), shortSide(b));
  // Stacked vertically: columns line up, small vertical gap.
  const vGap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
  if (
    ox / Math.min(a.x1 - a.x0, b.x1 - b.x0) > MERGE_MIN_OVERLAP &&
    vGap < minShort * maxGapOfShort
  ) {
    return true;
  }
  // Side by side horizontally: rows line up, small horizontal gap.
  const hGap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
  return (
    oy / Math.min(a.y1 - a.y0, b.y1 - b.y0) > MERGE_MIN_OVERLAP &&
    hGap < minShort * maxGapOfShort &&
    // Only when both halves are thin in the direction of travel — two
    // portrait sticks lying side by side must stay separate.
    a.y1 - a.y0 < a.x1 - a.x0 &&
    b.y1 - b.y0 < b.x1 - b.x0
  );
}

// Rows first (boxes whose vertical extents overlap belong to one row), then
// left to right inside a row — how a person reads the sheet. Plain
// top-then-left sorting would put a tall DIMM before a shorter stick to its
// left just because the DIMM's top edge is a few px higher.
function readingOrder(boxes: PxBox[]): PxBox[] {
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0);
  const rows: Array<{ y0: number; y1: number; items: PxBox[] }> = [];
  for (const b of sorted) {
    const row = rows.find(
      (r) => overlap(r.y0, r.y1, b.y0, b.y1) >= 0.5 * Math.min(b.y1 - b.y0, r.y1 - r.y0),
    );
    if (row) {
      row.items.push(b);
      row.y0 = Math.min(row.y0, b.y0);
      row.y1 = Math.max(row.y1, b.y1);
    } else {
      rows.push({ y0: b.y0, y1: b.y1, items: [b] });
    }
  }
  return rows
    .sort((a, b) => a.y0 - b.y0)
    .flatMap((r) => r.items.sort((a, b) => a.x0 - b.x0));
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function shortSide(b: PxBox): number {
  return Math.min(b.x1 - b.x0, b.y1 - b.y0);
}

function area(b: PxBox): number {
  return (b.x1 - b.x0) * (b.y1 - b.y0);
}
