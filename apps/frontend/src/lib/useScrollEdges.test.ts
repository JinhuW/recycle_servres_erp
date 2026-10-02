import { describe, it, expect } from 'vitest';
import { scrollEdges } from './useScrollEdges';

describe('scrollEdges', () => {
  it('is at both edges when the content fits', () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 500, clientHeight: 600 }))
      .toEqual({ atTop: true, atBottom: true });
  });

  it('is at the top only, before any scroll', () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 2000, clientHeight: 600 }))
      .toEqual({ atTop: true, atBottom: false });
  });

  it('is at neither edge in the middle', () => {
    expect(scrollEdges({ scrollTop: 700, scrollHeight: 2000, clientHeight: 600 }))
      .toEqual({ atTop: false, atBottom: false });
  });

  it('counts a scroll that settles just short of the end as the bottom', () => {
    expect(scrollEdges({ scrollTop: 1390, scrollHeight: 2000, clientHeight: 600 }))
      .toEqual({ atTop: false, atBottom: true });
    expect(scrollEdges({ scrollTop: 1300, scrollHeight: 2000, clientHeight: 600 }).atBottom)
      .toBe(false);
  });
});
