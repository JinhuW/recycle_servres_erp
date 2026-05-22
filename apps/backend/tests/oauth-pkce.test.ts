import { describe, it, expect } from 'vitest';
import { generateVerifier, challengeS256, verifyChallenge } from '../src/oauth/pkce';

describe('PKCE S256', () => {
  it('generates a verifier of 43-128 chars from the unreserved set', () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(/^[A-Za-z0-9_~.-]+$/.test(v)).toBe(true);
  });

  it('challengeS256 yields a 43-char base64url-without-padding hash', () => {
    const ch = challengeS256('abc');
    expect(ch.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(ch)).toBe(true);
    expect(ch.endsWith('=')).toBe(false);
  });

  it('verifyChallenge round-trips', () => {
    const v = generateVerifier();
    const ch = challengeS256(v);
    expect(verifyChallenge(ch, v)).toBe(true);
    expect(verifyChallenge(ch, v + 'x')).toBe(false);
  });
});
