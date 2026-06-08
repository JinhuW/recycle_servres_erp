import { describe, it, expect } from 'vitest';
import { filenameFromContentDisposition } from './api';

describe('filenameFromContentDisposition', () => {
  it('prefers the RFC 5987 filename* and decodes UTF-8 percent-encoding', () => {
    const cd =
      `attachment; filename="SO-4006-_-2026-06-08.xlsx"; ` +
      `filename*=UTF-8''SO-4006-${encodeURIComponent('深圳启航科技')}-2026-06-08.xlsx`;
    expect(filenameFromContentDisposition(cd)).toBe('SO-4006-深圳启航科技-2026-06-08.xlsx');
  });

  it('falls back to the plain filename= when there is no filename*', () => {
    expect(filenameFromContentDisposition('attachment; filename="sell-orders.xlsx"'))
      .toBe('sell-orders.xlsx');
  });

  it('returns null when the header is absent', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
  });
});
