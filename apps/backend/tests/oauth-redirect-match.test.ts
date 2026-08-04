import { describe, it, expect } from 'vitest';
import { isValidRedirectUri, redirectUriMatches } from '../src/oauth/server';

// Pure functions — no DB, so this stays a fast table test. The DB-backed
// behaviour they drive is covered in oauth-endpoints.test.ts.

describe('isValidRedirectUri', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['https://chatgpt.com/connector_platform_oauth_redirect', true],
    ['http://localhost/callback', true],
    ['http://localhost:53521/callback', true],
    ['http://127.0.0.1/callback', true],
    ['http://[::1]/callback', true],
    // Plain http off-loopback would send the code over the wire in clear.
    ['http://example.com/cb', false],
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    // RFC 6749 §3.1.2 — a fragment can't be matched and never reaches a server.
    ['https://example.com/cb#frag', false],
    ['not a url', false],
  ])('%s → %s', (uri, expected) => {
    expect(isValidRedirectUri(uri as string)).toBe(expected);
  });
});

describe('redirectUriMatches', () => {
  it('matches an exact non-loopback URI', () => {
    expect(redirectUriMatches(['https://claude.ai/cb'], 'https://claude.ai/cb')).toBe(true);
  });

  it('rejects a non-loopback URI that differs at all', () => {
    expect(redirectUriMatches(['https://claude.ai/cb'], 'https://claude.ai/cb2')).toBe(false);
  });

  it('ignores the port on a loopback URI (RFC 8252 §7.3)', () => {
    // Claude Code binds a fresh ephemeral port on every run.
    expect(redirectUriMatches(['http://localhost/callback'], 'http://localhost:53521/callback')).toBe(true);
    expect(redirectUriMatches(['http://localhost:1234/callback'], 'http://localhost:5678/callback')).toBe(true);
  });

  it('still requires path and query to match on loopback', () => {
    expect(redirectUriMatches(['http://localhost/callback'], 'http://localhost:1/other')).toBe(false);
    expect(redirectUriMatches(['http://localhost/cb?a=1'], 'http://localhost:1/cb?a=2')).toBe(false);
  });

  it('keeps localhost and 127.0.0.1 distinct', () => {
    expect(redirectUriMatches(['http://localhost/callback'], 'http://127.0.0.1:9/callback')).toBe(false);
    expect(redirectUriMatches(['http://127.0.0.1/callback'], 'http://localhost:9/callback')).toBe(false);
  });

  it('never relaxes the port for a non-loopback host', () => {
    expect(redirectUriMatches(['https://example.com/cb'], 'https://example.com:8443/cb')).toBe(false);
    // An attacker-controlled host must not borrow the loopback rule.
    expect(redirectUriMatches(['http://localhost/cb'], 'http://evil.test:80/cb')).toBe(false);
  });

  it('rejects a presented URI that is not a URL at all', () => {
    expect(redirectUriMatches(['http://localhost/cb'], 'nonsense')).toBe(false);
  });

  it('rejects an empty registration list', () => {
    expect(redirectUriMatches([], 'http://localhost:1/cb')).toBe(false);
  });
});
