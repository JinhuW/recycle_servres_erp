import { describe, it, expect } from 'vitest';
import {
  EMPTY_EDGES, MIN_EDGES, MIN_FIRE_GAP_MS, MIN_SHARPNESS, SAMPLE_INTERVAL_MS, STEADY_SAMPLES,
  MAX_SAMPLE_H, MAX_SAMPLE_W, MISS_TICKS,
  defaultBox, edgeDensity, initialAutoCapture, initialBoxTrack, motion, pickCamera, sampleRect,
  sharpness, stepAutoCapture, trackBox,
  type AutoCaptureState, type FrameSample,
} from './deskScan';

const W = 120;
const H = 80;

// Dark mat with a light label printed with small dark glyph blocks. Seeded so
// every call draws the same label; `offset` slides it sideways.
function label(offset = 0): Uint8Array {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const g = new Uint8Array(W * H).fill(20);
  for (let y = 20; y < 60; y++) {
    for (let x = 20; x < 100; x++) g[y * W + ((x + offset) % W)] = 230;
  }
  for (let k = 0; k < 90; k++) {
    const x0 = 22 + Math.floor(rnd() * 72);
    const y0 = 22 + Math.floor(rnd() * 34);
    const gw = 1 + Math.floor(rnd() * 4);
    const gh = 2 + Math.floor(rnd() * 3);
    for (let y = y0; y < y0 + gh; y++) {
      for (let x = x0; x < x0 + gw; x++) g[y * W + ((x + offset) % W)] = 15;
    }
  }
  return g;
}

// Repeated 3×3 box passes approximate a Gaussian defocus.
function blur(src: Uint8Array, passes = 4): Uint8Array {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
            s += cur[yy * W + xx];
            n++;
          }
        }
        out[y * W + x] = Math.round(s / n);
      }
    }
    cur = out;
  }
  return cur;
}

const emptyMat = () => new Uint8Array(W * H).fill(20);

function sampleOf(prev: Uint8Array | null, cur: Uint8Array): FrameSample {
  return {
    motion: prev ? motion(prev, cur) : null,
    edges: edgeDensity(cur, W, H),
    sharpness: sharpness(cur, W, H),
  };
}

// Feeds frames through the machine, one sample interval apart; returns the
// indices of the frames that fired.
function run(frames: Uint8Array[], start: AutoCaptureState = initialAutoCapture(), t0 = 0) {
  let state = start;
  let prev: Uint8Array | null = null;
  const fired: number[] = [];
  frames.forEach((f, i) => {
    const r = stepAutoCapture(state, sampleOf(prev, f), t0 + i * SAMPLE_INTERVAL_MS);
    state = r.state;
    if (r.fire) fired.push(i);
    prev = f;
  });
  return { fired, state };
}

describe('frame metrics', () => {
  it('tells a label from an empty mat and a blurred label', () => {
    expect(edgeDensity(label(), W, H)).toBeGreaterThan(MIN_EDGES);
    expect(edgeDensity(emptyMat(), W, H)).toBeLessThan(EMPTY_EDGES);
    expect(sharpness(label(), W, H)).toBeGreaterThan(MIN_SHARPNESS);
    expect(sharpness(blur(label()), W, H)).toBeLessThan(MIN_SHARPNESS);
    // Contrast-invariant: a dimmer light doesn't change the verdict.
    const dim = label().map(v => Math.round(v * 0.4));
    expect(sharpness(dim, W, H)).toBeCloseTo(sharpness(label(), W, H), 1);
  });
});

describe('stepAutoCapture', () => {
  it('never fires on an empty mat', () => {
    expect(run(Array.from({ length: 20 }, emptyMat)).fired).toEqual([]);
  });

  it('never fires while the label is moving', () => {
    const frames = Array.from({ length: 20 }, (_, i) => label(i * 4));
    expect(run(frames).fired).toEqual([]);
  });

  it('fires once, after the label has been still for STEADY_SAMPLES samples', () => {
    const frames = Array.from({ length: 20 }, () => label());
    // Frame 0 has no previous frame to diff, so the steady count starts at 1.
    expect(run(frames).fired).toEqual([STEADY_SAMPLES]);
  });

  it('does not fire on an out-of-focus label', () => {
    const frames = Array.from({ length: 20 }, () => blur(label()));
    expect(run(frames).fired).toEqual([]);
  });

  it('waits for sharpness to come back to its peak while focus hunts', () => {
    const sharpFrame = label();
    const soft = blur(label(), 1);
    // Hunting: sharp, then softer frames (still above the floor but below the
    // peak ratio), then sharp again. Motion stays ~0 because a real hunt moves
    // no pixels much; fake that by passing the samples in directly.
    const sharpS = sharpness(sharpFrame, W, H);
    const softS = sharpness(soft, W, H);
    expect(softS).toBeLessThan(0.85 * sharpS);
    const edges = edgeDensity(sharpFrame, W, H);
    const seq = [sharpS, softS, softS, softS, sharpS, sharpS, sharpS];
    let state = initialAutoCapture();
    const fired: number[] = [];
    seq.forEach((s, i) => {
      const r = stepAutoCapture(state, { motion: 0, edges, sharpness: s }, i * SAMPLE_INTERVAL_MS);
      state = r.state;
      if (r.fire) fired.push(i);
    });
    expect(fired).toEqual([6]);
  });

  it('does not fire again until the scene changes, then fires for the next stick', () => {
    const still = Array.from({ length: 12 }, () => label());
    const away = Array.from({ length: 3 }, emptyMat);
    const next = Array.from({ length: 16 }, () => label(1));
    const { fired } = run([...still, ...away, ...next]);
    expect(fired.length).toBe(2);
    expect(fired[1]).toBeGreaterThan(still.length + away.length);
  });

  it('keeps MIN_FIRE_GAP_MS between fires even when the scene changes quickly', () => {
    const fired = { phase: 'fired', count: 0, bestSharpness: 0, lastFireAt: 0 } as const;
    // Re-arm on the empty mat, then a still label within the gap.
    const frames = [emptyMat(), ...Array.from({ length: 6 }, () => label())];
    const early = run(frames, fired, SAMPLE_INTERVAL_MS);
    expect(early.fired).toEqual([]);
    const late = run(frames, fired, MIN_FIRE_GAP_MS);
    expect(late.fired.length).toBe(1);
  });
});

describe('the box that follows the stick', () => {
  const stick = { x: 0.2, y: 0.4, w: 0.55, h: 0.18 };

  it('defaults to a wide centred box inside the frame', () => {
    const b = defaultBox();
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 5);
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 5);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y + b.h).toBeLessThanOrEqual(1);
  });

  it('locks onto the first detection', () => {
    const t = trackBox(initialBoxTrack(), stick);
    expect(t.locked).toBe(true);
    expect(t.box).toEqual(stick);
  });

  it('ignores detection jitter but follows a real move', () => {
    const t = trackBox(initialBoxTrack(), stick);
    const jitter = trackBox(t, { ...stick, x: stick.x + 0.01 });
    expect(jitter.box).toBe(t.box);
    const moved = trackBox(t, { ...stick, x: stick.x + 0.05 });
    expect(moved.box.x).toBeCloseTo(stick.x + 0.05, 5);
  });

  it('holds the stick box through a few missed detections, then falls back', () => {
    let t = trackBox(initialBoxTrack(), stick);
    for (let i = 0; i < MISS_TICKS - 1; i++) {
      t = trackBox(t, null);
      expect(t.locked).toBe(true);
      expect(t.box).toEqual(stick);
    }
    t = trackBox(t, null);
    expect(t.locked).toBe(false);
    expect(t.box).toEqual(defaultBox());
  });

  it('samples the whole box on a 1920 feed and caps it on 4K, never scaling', () => {
    const small = sampleRect(stick, 1920, 1440);
    expect(small.w).toBe(Math.round(0.55 * 1920));
    expect(small.h).toBe(Math.round(0.18 * 1440));
    const big = sampleRect({ x: 0.05, y: 0.3, w: 0.9, h: 0.4 }, 3840, 2160);
    expect(big.w).toBe(MAX_SAMPLE_W);
    expect(big.h).toBe(MAX_SAMPLE_H);
    // Centred in the box, inside the frame.
    expect(big.x + big.w / 2).toBeCloseTo((0.05 + 0.45) * 3840, 0);
    expect(big.x).toBeGreaterThanOrEqual(0);
    expect(big.y + big.h).toBeLessThanOrEqual(2160);
  });

  it('re-arms after a fire when the box changes size (motion reads as Infinity)', () => {
    const fired = { phase: 'fired', count: 0, bestSharpness: 0, lastFireAt: 0 } as const;
    const prev = new Uint8Array(100);
    const cur = new Uint8Array(120);
    const r = stepAutoCapture(fired, { motion: motion(prev, cur), edges: 0.05, sharpness: 2 }, 10_000);
    expect(r.state.phase).toBe('armed');
  });
});

describe('pickCamera', () => {
  const mac = { deviceId: 'mac', label: 'FaceTime HD Camera' };
  const desk = { deviceId: 'desk', label: "Jinhu's iPhone Desk View Camera" };
  const phone = { deviceId: 'phone', label: "Jinhu's iPhone Camera" };

  it('prefers the saved camera', () => {
    expect(pickCamera([mac, phone], 'FaceTime HD Camera')).toBe('mac');
  });

  it('falls back to the Continuity iPhone camera, skipping Desk View', () => {
    expect(pickCamera([mac, desk, phone], null)).toBe('phone');
    expect(pickCamera([desk, phone], 'Gone Camera')).toBe('phone');
  });

  it('falls back to the first camera, and to null when there is none', () => {
    expect(pickCamera([mac], null)).toBe('mac');
    expect(pickCamera([], null)).toBeNull();
  });
});
