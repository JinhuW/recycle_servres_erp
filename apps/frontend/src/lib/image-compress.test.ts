import { describe, it, expect } from 'vitest';
import { fitWithin } from './image-compress';

describe('fitWithin', () => {
  it('leaves dimensions unchanged when the long edge is within the cap', () => {
    expect(fitWithin(2000, 1500, 2560)).toEqual({ width: 2000, height: 1500 });
  });
  it('returns the same dimensions at the exact boundary', () => {
    expect(fitWithin(2560, 1440, 2560)).toEqual({ width: 2560, height: 1440 });
  });
  it('downscales a landscape image so the width hits the cap', () => {
    expect(fitWithin(3840, 2160, 2560)).toEqual({ width: 2560, height: 1440 });
  });
  it('downscales a portrait image so the height hits the cap', () => {
    expect(fitWithin(2160, 3840, 2560)).toEqual({ width: 1440, height: 2560 });
  });
  it('downscales a square image on both edges', () => {
    expect(fitWithin(4000, 4000, 2560)).toEqual({ width: 2560, height: 2560 });
  });
  it('never upscales a small image', () => {
    expect(fitWithin(800, 600, 2560)).toEqual({ width: 800, height: 600 });
  });
});
