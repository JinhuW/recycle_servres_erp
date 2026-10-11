import { describe, it, expect } from 'vitest';
import { applyPatch, canApply, findingText, isOpen, openIssuesByLine, type AiFinding } from './aiReview';

const f = (over: Partial<AiFinding>): AiFinding => ({
  id: 'f', lineId: 'l1', severity: 'warn', code: 'spec_mismatch', field: 'capacity',
  currentValue: '16GB', suggestedValue: '32GB', message: '', confidence: 0.6, sources: [],
  resolution: null, resolvedAt: null, resolvedBy: null, stale: false, ...over,
});
const t = (k: string, v?: Record<string, string | number>) =>
  k + (v ? ':' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : '');

describe('aiReview', () => {
  it('counts open errors and warnings per line, not notes, answers or stale ones', () => {
    const m = openIssuesByLine([
      f({ id: 'a' }), f({ id: 'b', severity: 'error' }), f({ id: 'c', severity: 'info' }),
      f({ id: 'd', resolution: 'dismissed' }), f({ id: 'e', stale: true }), f({ id: 'g', lineId: null }),
    ]);
    expect([...m]).toEqual([['l1', 2]]);
  });

  it('applies only an open finding that names a field and a value', () => {
    expect(canApply(f({}))).toBe(true);
    expect(canApply(f({ suggestedValue: null }))).toBe(false);
    expect(canApply(f({ stale: true }))).toBe(false);
    expect(isOpen(f({ resolution: 'applied' }))).toBe(false);
  });

  it('builds the line patch, numeric for RPM', () => {
    expect(applyPatch(f({}))).toEqual({ id: 'l1', capacity: '32GB' });
    expect(applyPatch(f({ field: 'rpm', suggestedValue: '7200' }))).toEqual({ id: 'l1', rpm: 7200 });
  });

  it('words a finding from its code', () => {
    expect(findingText(f({}), t, 'en-US')).toBe('aiRevCode_spec_mismatch:field=aiRevField_capacity,current=16GB,suggested=32GB,market=');
  });
});
