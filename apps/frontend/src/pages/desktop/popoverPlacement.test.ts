import { describe, it, expect } from 'vitest';
import { placePopover } from './popoverPlacement';

// Sizes of the two Payments pickers when full.
const PO = { width: 320, height: 312, gap: 4 };   // PoPicker, right-aligned
const PAIR = { width: 380, height: 262, gap: 4 }; // PairPicker, left-aligned

const VIEWPORT = { width: 1440, height: 900 };

function rect(top: number, height: number, left: number, width: number) {
  return { top, bottom: top + height, left, right: left + width };
}

describe('placePopover', () => {
  it('opens below the anchor when there is room', () => {
    const { top } = placePopover({
      anchor: rect(100, 24, 200, 90), viewport: VIEWPORT, align: 'left', ...PAIR,
    });
    expect(top).toBe(128); // 100 + 24 + gap
  });

  it('flips above when the anchor is near the bottom', () => {
    // 830 + 24 = 854 bottom, leaving 46px — far less than 262 + 4.
    const { top } = placePopover({
      anchor: rect(830, 24, 200, 90), viewport: VIEWPORT, align: 'left', ...PAIR,
    });
    expect(top).toBe(564); // 830 - 262 - 4
  });

  it('flips at the exact boundary, not one pixel late', () => {
    // Room beneath is exactly height + gap, which still fits.
    const fits = placePopover({
      anchor: rect(600, 34, 200, 90), viewport: { width: 1440, height: 900 }, align: 'left', ...PAIR,
    });
    expect(fits.top).toBe(638);

    // One pixel less room, so it must flip.
    const flips = placePopover({
      anchor: rect(601, 34, 200, 90), viewport: { width: 1440, height: 900 }, align: 'left', ...PAIR,
    });
    expect(flips.top).toBe(335); // 601 - 262 - 4
  });

  it('caps to the roomier side when it fits on neither', () => {
    // A short viewport: 140px below, 64px above, a 262px panel.
    const { top, maxHeight } = placePopover({
      anchor: rect(72, 24, 200, 90), viewport: { width: 1440, height: 240 }, align: 'left', ...PAIR,
    });
    expect(top).toBe(100); // 72 + 24 + gap
    expect(maxHeight).toBe(140); // 240 - 96 - gap
  });

  it('never covers its own anchor when capped above', () => {
    // 287px below, 300px above, a 305px card with a 6px gap: neither fits.
    // Pinning it to the viewport's top would have covered the anchor row.
    const { top, maxHeight } = placePopover({
      anchor: rect(300, 13, 200, 13), viewport: { width: 1440, height: 600 },
      align: 'left', width: 320, height: 305, gap: 6,
    });
    expect(top).toBe(6);
    expect(maxHeight).toBe(288); // 300 - 2 * gap
    expect(top + maxHeight!).toBeLessThanOrEqual(300 - 6);
  });

  it('leaves maxHeight unset when the panel fits', () => {
    const { maxHeight } = placePopover({
      anchor: rect(100, 24, 200, 90), viewport: VIEWPORT, align: 'left', ...PAIR,
    });
    expect(maxHeight).toBeUndefined();
  });

  it('right-aligns the PO picker to the anchor', () => {
    const { left } = placePopover({
      anchor: rect(100, 24, 900, 120), viewport: VIEWPORT, align: 'right', ...PO,
    });
    expect(left).toBe(700); // right (1020) - width (320)
  });

  it('left-aligns the pair picker to the anchor', () => {
    const { left } = placePopover({
      anchor: rect(100, 24, 200, 90), viewport: VIEWPORT, align: 'left', ...PAIR,
    });
    expect(left).toBe(200);
  });

  it('clamps against the right edge of the viewport', () => {
    // Anchored at the far right, a 380px panel would run to 1490.
    const { left } = placePopover({
      anchor: rect(100, 24, 1400, 30), viewport: VIEWPORT, align: 'left', ...PAIR,
    });
    expect(left).toBe(1056); // 1440 - 380 - 4
  });

  it('clamps against the left edge of the viewport', () => {
    // Right-aligning to an anchor near x=0 would put the panel at -290.
    const { left } = placePopover({
      anchor: rect(100, 24, 0, 30), viewport: VIEWPORT, align: 'right', ...PO,
    });
    expect(left).toBe(4);
  });

  it('keeps the left clamp winning over the right one in a narrow viewport', () => {
    // Viewport narrower than the popover: both clamps fight, gap must win, or
    // the panel starts off-screen left and its first column is unreachable.
    const { left } = placePopover({
      anchor: rect(100, 24, 10, 30), viewport: { width: 320, height: 900 }, align: 'left', ...PAIR,
    });
    expect(left).toBe(4);
  });
});
