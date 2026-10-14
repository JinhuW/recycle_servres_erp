import { describe, it, expect } from 'vitest';
import { sparkGeometry } from './sparkline';

const TOP = 8, H = 84;
const inside = (y: number) => y >= TOP - 1e-9 && y <= TOP + H + 1e-9;

describe('sparkGeometry', () => {
  it('keeps a mixed gain/loss series on the canvas, zero in between', () => {
    const g = sparkGeometry([-100, 100], TOP, H);
    expect(inside(g.y(-100))).toBe(true);
    expect(inside(g.y(100))).toBe(true);
    expect(g.y(-100)).toBe(TOP + H);
    expect(g.y(100)).toBe(TOP);
    expect(g.baseline).toBeCloseTo(TOP + H / 2);
    expect(g.crossesZero).toBe(true);
  });

  it('keeps an all-loss series on the canvas, below the baseline', () => {
    const g = sparkGeometry([-100, -50], TOP, H);
    expect(inside(g.y(-100))).toBe(true);
    expect(inside(g.y(-50))).toBe(true);
    expect(g.baseline).toBe(TOP);
    expect(g.y(-50)).toBeGreaterThan(g.baseline);
  });

  it('scales an all-gain series from zero as before', () => {
    const g = sparkGeometry([20, 80], TOP, H);
    expect(g.y(80)).toBe(TOP);
    expect(g.baseline).toBe(TOP + H);
    expect(g.crossesZero).toBe(false);
  });

  it('draws a zero-only series as a flat line on the baseline', () => {
    const g = sparkGeometry([0, 0, 0], TOP, H);
    expect(g.y(0)).toBe(g.baseline);
    expect(inside(g.baseline)).toBe(true);
  });
});
