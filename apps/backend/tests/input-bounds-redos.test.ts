import { describe, it, expect, beforeEach } from 'vitest';
import { canonicalPartNumber, partPrefixPattern, partPrefixPatternLinear } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { isEmail } from '../src/lib/email';

// Input an anonymous or ordinary caller controls used to reach a backtracking
// regex, a Prometheus label, or Postgres with bytes it refuses.

function timed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('pathological strings stay linear', () => {
  it('isEmail refuses the dot-run address quickly', () => {
    const evil = 'a@' + '.'.repeat(60_000) + '@';
    expect(timed(() => expect(isEmail(evil)).toBe(false))).toBeLessThan(200);
    // Under the length cap, where the regex itself has to be linear.
    const short = 'a@' + '.'.repeat(250) + '@';
    expect(timed(() => { for (let i = 0; i < 1000; i++) isEmail(short); })).toBeLessThan(200);
    expect(isEmail('ops@example.com')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
  });

  it('canonicalPartNumber handles long blank runs after a label letter', () => {
    for (const evil of [
      'P' + ' '.repeat(64_000) + 'X',
      'PART' + ' '.repeat(64_000) + 'X',
      'S/' + ' '.repeat(64_000) + 'X',
      ' '.repeat(64_000) + 'P',
    ]) {
      expect(timed(() => canonicalPartNumber(evil))).toBeLessThan(200);
    }
  });

  // The JS prefix is a rewrite of the template SQL still runs; every short
  // string over the label alphabet must strip to the same thing under both.
  it('the linear prefix strips exactly what the template does', () => {
    const ws = '[ \\t\\n\\v\\f\\r]';
    const template = new RegExp(partPrefixPattern(ws), 'i');
    const linear = new RegExp(partPrefixPatternLinear(ws), 'i');
    const alphabet = ['P', 'N', 'S', '/', ' ', '\t', ':', '#', 'A', 'R', 'T', 'O', 'U', 'M', 'B', 'E', 'X'];
    const walk = (s: string, depth: number) => {
      if (s.replace(template, '') !== s.replace(linear, '')) {
        expect(s.replace(linear, ''), JSON.stringify(s)).toBe(s.replace(template, ''));
      }
      if (depth === 0) return;
      for (const ch of alphabet) walk(s + ch, depth - 1);
    };
    walk('', 5);
    for (const s of ['PART NUMBER # hma 84gr7', 'p/n: abc', 'S / N  X', 'PARTNO:X', 'SNK-P0048AP4']) {
      expect(s.replace(linear, '')).toBe(s.replace(template, ''));
    }
  });
});

describe('market lookups cap part-number length', () => {
  beforeEach(async () => { await resetDb(); });

  it('skips an over-long part number on /lookup and /chips, and /parts answers empty', async () => {
    const { token } = await loginAs(ALEX);
    const evil = 'P' + ' '.repeat(64_000) + 'X';
    for (const path of ['/api/market/lookup', '/api/market/chips']) {
      const t0 = performance.now();
      const r = await api<{ items: Record<string, unknown> }>('POST', path, {
        token, body: { partNumbers: [evil] },
      });
      expect(r.status, path).toBe(200);
      expect(r.body.items).toEqual({});
      expect(performance.now() - t0).toBeLessThan(2000);
    }
    const r = await api<{ items: unknown[] }>('GET', `/api/market/parts?q=${encodeURIComponent('P' + ' '.repeat(5000) + 'X')}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});

describe('public forms refuse text Postgres cannot store', () => {
  beforeEach(async () => { await resetDb(); });

  const quote = (over: Record<string, unknown>, ip: string) => api<{ error?: string }>('POST', '/api/public/quote', {
    headers: { 'X-Forwarded-For': ip, 'X-Requested-By': '' },
    body: {
      name: 'Pat', customer_type: 'individual', email: 'pat@example.com', hardware: ['RAM'], ...over,
    },
  });

  it('answers 400, not 500, for a NUL byte or a lone surrogate', async () => {
    expect((await quote({ notes: 'a\u0000b' }, '203.0.113.71')).status).toBe(400);
    expect((await quote({ name: 'x\ud800' }, '203.0.113.72')).status).toBe(400);
    expect((await quote({ hardware: ['RAM', '\udc00'] }, '203.0.113.73')).status).toBe(400);
    const intake = await api('POST', '/api/public/intake', {
      headers: { 'X-Forwarded-For': '203.0.113.74', 'X-Requested-By': '' },
      body: { email: 'pat@example.com', lines: [{ category: 'RAM', qty: 1, fields: { part_number: 'A\u0000' } }] },
    });
    expect(intake.status).toBe(400);
    const [{ n }] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM web_submissions`;
    expect(n).toBe(0);
  });

  it('still takes a paired surrogate (an emoji)', async () => {
    expect((await quote({ notes: 'thanks \u{1F600}' }, '203.0.113.75')).status).toBe(201);
  });

  it('refuses the dot-run email quickly', async () => {
    const t0 = performance.now();
    const r = await quote({ email: 'a@' + '.'.repeat(60_000) + '@' }, '203.0.113.76');
    expect(r.status).toBe(400);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('/oauth/token metric labels', () => {
  beforeEach(async () => { await resetDb(); });

  it('does not mint a label from an unknown grant_type', async () => {
    const marker = 'zz' + 'q'.repeat(500);
    const r = await api('POST', '/oauth/token', { body: { grant_type: marker } });
    expect(r.status).toBe(401);
    const text = (await api<string>('GET', '/metrics')).body as unknown as string;
    expect(text).not.toContain(marker);
    expect(text).toMatch(/oauth_grants_total\{[^}]*grant_type="other"[^}]*status="error"[^}]*\}/);
  });
});

describe('DCR /oauth/register bounds redirect_uris', () => {
  beforeEach(async () => { await resetDb(); });

  const register = (redirectUris: string[]) => api<{ error?: string }>('POST', '/oauth/register', {
    body: { client_name: 'bounds', redirect_uris: redirectUris },
  });

  it('refuses more than 10 redirect URIs', async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://example.com/cb${i}`);
    const r = await register(uris);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_redirect_uri');
    expect((await register(uris.slice(0, 10))).status).toBe(201);
  });

  it('refuses a redirect URI over 2048 characters', async () => {
    const r = await register([`https://example.com/${'a'.repeat(2048)}`]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_redirect_uri');
    const [{ n }] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM oauth_clients WHERE name = 'bounds'`;
    expect(n).toBe(0);
  });
});
