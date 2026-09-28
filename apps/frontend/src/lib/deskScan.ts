// Desk scanner auto-capture: decides, from live camera frames, when a label
// under an overhead camera is worth sending to OCR.  Pure — the DOM side
// (video, canvas, getUserMedia) lives in pages/desktop/submit/DeskCamera.tsx.
//
// A frame "counts" when something with text-like edges is in view, nothing is
// moving, and focus has settled.  K of those in a row fire one capture; the
// machine then refuses to fire again until the scene changes, so a failed or
// slow scan can't loop on the same still frame and eat the scan rate limit.

// Tuned for an iPhone (Continuity Camera) about 30 cm above a dark mat under a
// ring light.  Values are on 0–255 grayscale sampled at native resolution.
export const SAMPLE_INTERVAL_MS = 250;
export const STEADY_SAMPLES = 3;
// Mean absolute per-pixel change between samples.  Sensor noise sits ~1–3.
export const MAX_MOTION = 5;
export const REARM_MOTION = 14;
// Share of pixels with a strong gradient.  Label text is several percent; an
// empty mat is well under one.
export const MIN_EDGES = 0.02;
export const EMPTY_EDGES = 0.008;
export const EDGE_GRADIENT = 48;
// See sharpness(): crisp print scores ~1–3, a label a few pixels out of
// focus falls under 0.5.
export const MIN_SHARPNESS = 0.55;
// Autofocus hunts: a frame only counts once it is near the sharpest seen
// while the scene has been still.
export const SHARP_PEAK_RATIO = 0.85;
export const MIN_FIRE_GAP_MS = 3000;

export type FrameSample = {
  // null on the first sample after (re)start — no previous frame to diff.
  motion: number | null;
  edges: number;
  sharpness: number;
};

export type AutoCaptureState = {
  phase: 'armed' | 'steady' | 'fired';
  count: number;
  bestSharpness: number;
  lastFireAt: number | null;
};

export const initialAutoCapture = (): AutoCaptureState => ({
  phase: 'armed', count: 0, bestSharpness: 0, lastFireAt: null,
});

export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Integer Rec. 601 luma.
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

// RMS of the Laplacian over mean gradient magnitude.  Dividing out the
// gradient makes it contrast-invariant, so a brighter ring light or a glossy
// vs matte label doesn't move the threshold; defocus lowers it steadily.
export function sharpness(g: Uint8Array, w: number, h: number): number {
  let lapSq = 0;
  let grad = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      lapSq += lap * lap;
      grad += Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]);
      n++;
    }
  }
  if (!n || !grad) return 0;
  return Math.sqrt(lapSq / n) / (grad / n);
}

export function edgeDensity(g: Uint8Array, w: number, h: number): number {
  let strong = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(g[i + 1] - g[i - 1]);
      const gy = Math.abs(g[i + w] - g[i - w]);
      if (gx + gy > EDGE_GRADIENT) strong++;
      n++;
    }
  }
  return n ? strong / n : 0;
}

export function motion(prev: Uint8Array, cur: Uint8Array): number {
  if (prev.length !== cur.length || !cur.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < cur.length; i++) sum += Math.abs(cur[i] - prev[i]);
  return sum / cur.length;
}

export function analyzeFrame(
  rgba: Uint8ClampedArray, w: number, h: number, prev: Uint8Array | null,
): { gray: Uint8Array; sample: FrameSample } {
  const gray = toGray(rgba, w, h);
  return {
    gray,
    sample: {
      motion: prev ? motion(prev, gray) : null,
      edges: edgeDensity(gray, w, h),
      sharpness: sharpness(gray, w, h),
    },
  };
}

export function stepAutoCapture(
  s: AutoCaptureState, sample: FrameSample, now: number,
): { state: AutoCaptureState; fire: boolean; progress: number } {
  if (s.phase === 'fired') {
    const changed = (sample.motion != null && sample.motion > REARM_MOTION)
      || sample.edges < EMPTY_EDGES;
    const state = changed ? { ...initialAutoCapture(), lastFireAt: s.lastFireAt } : s;
    return { state, fire: false, progress: 0 };
  }

  const still = sample.motion != null && sample.motion <= MAX_MOTION;
  if (!still || sample.edges < MIN_EDGES) {
    return { state: { ...initialAutoCapture(), lastFireAt: s.lastFireAt }, fire: false, progress: 0 };
  }

  const best = Math.max(s.bestSharpness, sample.sharpness);
  const sharp = sample.sharpness >= MIN_SHARPNESS && sample.sharpness >= SHARP_PEAK_RATIO * best;
  const count = sharp ? s.count + 1 : 0;
  const progress = Math.min(count / STEADY_SAMPLES, 1);
  const gapOk = s.lastFireAt == null || now - s.lastFireAt >= MIN_FIRE_GAP_MS;

  if (count >= STEADY_SAMPLES && gapOk) {
    return {
      state: { phase: 'fired', count: 0, bestSharpness: 0, lastFireAt: now },
      fire: true,
      progress: 1,
    };
  }
  return {
    state: { phase: 'steady', count, bestSharpness: best, lastFireAt: s.lastFireAt },
    fire: false,
    progress,
  };
}

// ── The box on screen: follows the stick ────────────────────────────────────
//
// The box is what the trigger judges and what gets cropped, so it tracks the
// detected stick (findRamStickInPhoto) and falls back to a wide default when
// there's none. Boxes are fractions of the frame.

export type FrameBox = { x: number; y: number; w: number; h: number };

// Detection moves by a few pixels frame to frame on a still stick; moving the
// sample rect for that would read as motion and nothing would ever fire.
export const BOX_JITTER = 0.02;
// Detection passes (every other sample, so ~2 s) a stick box survives without
// a hit before the default returns.
// Stops a flaky frame flipping the box — and re-arming the trigger — while the
// stick hasn't moved.
export const MISS_TICKS = 4;
// Largest native-pixel region the trigger reads. Never scaled: downscaling
// hides defocus and inflates sharpness.
export const MAX_SAMPLE_W = 1280;
export const MAX_SAMPLE_H = 720;

export const defaultBox = (): FrameBox => ({ x: 0.06, y: 0.275, w: 0.88, h: 0.45 });

export type BoxTrack = { box: FrameBox; locked: boolean; misses: number };

export const initialBoxTrack = (): BoxTrack => ({ box: defaultBox(), locked: false, misses: 0 });

const moved = (a: FrameBox, b: FrameBox): boolean =>
  Math.abs(a.x - b.x) > BOX_JITTER
  || Math.abs(a.y - b.y) > BOX_JITTER
  || Math.abs(a.x + a.w - (b.x + b.w)) > BOX_JITTER
  || Math.abs(a.y + a.h - (b.y + b.h)) > BOX_JITTER;

export function trackBox(t: BoxTrack, detected: FrameBox | null): BoxTrack {
  if (detected) {
    if (t.locked && !moved(t.box, detected)) return t.misses ? { ...t, misses: 0 } : t;
    return { box: detected, locked: true, misses: 0 };
  }
  if (!t.locked) return t;
  if (t.misses + 1 < MISS_TICKS) return { ...t, misses: t.misses + 1 };
  return initialBoxTrack();
}

// Native-pixel rect the trigger samples: the box's centre, clipped to the
// sample cap. On a 1920-wide Continuity feed a stick box fits whole.
export function sampleRect(
  box: FrameBox, frameW: number, frameH: number,
): { x: number; y: number; w: number; h: number } {
  const bw = Math.max(1, Math.round(box.w * frameW));
  const bh = Math.max(1, Math.round(box.h * frameH));
  const w = Math.min(bw, MAX_SAMPLE_W);
  const h = Math.min(bh, MAX_SAMPLE_H);
  const x = Math.round(box.x * frameW + (bw - w) / 2);
  const y = Math.round(box.y * frameH + (bh - h) / 2);
  return {
    x: Math.max(0, Math.min(x, frameW - w)),
    y: Math.max(0, Math.min(y, frameH - h)),
    w,
    h,
  };
}

export type CameraDevice = { deviceId: string; label: string };

// Continuity Camera shows up as "<name>'s iPhone Camera", alongside a separate
// "… Desk View Camera" device that is a warped top-down crop — not what an
// overhead mount wants.
export function pickCamera(devices: CameraDevice[], savedLabel: string | null): string | null {
  if (!devices.length) return null;
  if (savedLabel) {
    const saved = devices.find(d => d.label === savedLabel);
    if (saved) return saved.deviceId;
  }
  const iphone = devices.find(d => /iphone/i.test(d.label) && !/desk view/i.test(d.label));
  return (iphone ?? devices[0]).deviceId;
}
