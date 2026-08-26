import { describe, it, expect, afterEach } from 'vitest';
import { aiCaptureEnabled, categories, resetLookups } from './lookups';

const cat = (id: string, aiCapture: boolean, position: number) => ({
  id, label: id, icon: id.toLowerCase(), enabled: true, aiCapture, defaultMargin: 0.3, position,
});

describe('aiCaptureEnabled', () => {
  afterEach(() => resetLookups());

  it('falls back to RAM-only before the lookups fetch lands', () => {
    expect(aiCaptureEnabled('RAM')).toBe(true);
    expect(aiCaptureEnabled('SSD')).toBe(false);
  });

  it('follows categories.ai_capture once loaded', () => {
    categories.push(cat('RAM', true, 1), cat('SSD', true, 2), cat('HDD', false, 3));
    expect(aiCaptureEnabled('RAM')).toBe(true);
    expect(aiCaptureEnabled('SSD')).toBe(true);
    expect(aiCaptureEnabled('HDD')).toBe(false);
    expect(aiCaptureEnabled('Other')).toBe(false);
  });
});
