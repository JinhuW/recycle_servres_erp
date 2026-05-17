import { describe, it, expect } from 'vitest';
import { api } from './helpers/app';

// Regression: with credentials:true the old config reflected ANY origin,
// letting any site make credentialed calls. CORS_ALLOWED_ORIGINS now gates it.
describe('CORS allowlist', () => {
  const ALLOW = 'https://app.example.com';

  it('reflects an allowed origin when CORS_ALLOWED_ORIGINS is set', async () => {
    const r = await api('GET', '/', {
      env: { CORS_ALLOWED_ORIGINS: ALLOW },
      headers: { Origin: ALLOW },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe(ALLOW);
  });

  it('denies an origin outside the allowlist', async () => {
    const r = await api('GET', '/', {
      env: { CORS_ALLOWED_ORIGINS: ALLOW },
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(r.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
  });

  it('stays permissive in dev when the allowlist is unset', async () => {
    const r = await api('GET', '/', { headers: { Origin: 'http://localhost:5173' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
