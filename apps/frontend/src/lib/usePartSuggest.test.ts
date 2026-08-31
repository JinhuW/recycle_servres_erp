import { describe, it, expect } from 'vitest';
import { suggestQuery, SUGGEST_MIN } from './usePartSuggest';

// The field fires on every keystroke, so the gate that decides whether to ask
// the server at all is the piece worth pinning down. The hook around it needs a
// renderer; this half doesn't.

describe('suggestQuery', () => {
  it('canonicalises the way the server matches', () => {
    expect(suggestQuery('m393a4k40')).toBe('M393A4K40');
    expect(suggestQuery('PN: ABC 123')).toBe('ABC123');
    expect(suggestQuery('  abc  ')).toBe('ABC');
  });

  it('stays silent until there is enough to search on', () => {
    expect(suggestQuery('')).toBe('');
    expect(suggestQuery(null)).toBe('');
    expect(suggestQuery(undefined)).toBe('');
    expect(suggestQuery('a')).toBe('');
    expect(suggestQuery('  b  ')).toBe('');
    // A prefix that canonicalises away is not a query either.
    expect(suggestQuery('PN:')).toBe('');
  });

  it('asks as soon as the minimum is reached', () => {
    expect(suggestQuery('ab').length).toBe(SUGGEST_MIN);
    expect(suggestQuery('ab')).toBe('AB');
  });
});
