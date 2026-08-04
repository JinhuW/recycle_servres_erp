import { describe, it, expect } from 'vitest';
import { readSafeNext } from './route';

// `next` comes back from the backend's /oauth/authorize bounce and is then fed
// straight to window.location.replace, so anything that escapes the origin here
// is an open redirect on the login page.
describe('readSafeNext', () => {
  it('returns a same-origin absolute path', () => {
    expect(readSafeNext('?next=%2Foauth%2Fauthorize%3Freq%3Dabc'))
      .toBe('/oauth/authorize?req=abc');
  });

  it('returns null when absent or empty', () => {
    expect(readSafeNext('')).toBeNull();
    expect(readSafeNext('?foo=1')).toBeNull();
    expect(readSafeNext('?next=')).toBeNull();
  });

  it.each([
    '//evil.com',              // protocol-relative — navigates off-origin
    'https://evil.com',
    'http://evil.com',
    '/\\evil.com',             // backslash form some browsers normalise to //
    'javascript:alert(1)',
    'oauth/authorize',         // relative, not rooted
  ])('rejects %s', (candidate) => {
    expect(readSafeNext(`?next=${encodeURIComponent(candidate)}`)).toBeNull();
  });
});
