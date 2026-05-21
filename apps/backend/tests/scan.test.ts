import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { multipart } from './helpers/app';
import { loginAs, MARCUS, ALEX } from './helpers/auth';

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'label.jpg', { type: 'image/jpeg' });
}

describe('POST /api/scan/label', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stub path: no key/no AI → canned extraction, persists a label_scans row', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token });
    expect(r.status).toBe(200);
    const body = r.body as { provider: string; extracted: Record<string, string>; confidence: number };
    expect(body.provider).toBe('stub');
    expect(body.extracted.brand).toBe('Samsung');
    const sql = getTestDb();
    const rows = await sql`SELECT provider FROM label_scans WHERE category = 'RAM'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].provider).toBe('stub');
  });

  it('openrouter path: env key + mocked fetch → provider openrouter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"brand":"SK Hynix"}' } }] }), { status: 200 }),
      ),
    );
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(200);
    const body = r.body as { provider: string; extracted: Record<string, string> };
    expect(body.provider).toBe('openrouter');
    expect(body.extracted.brand).toBe('SK Hynix');
  });

  it('fail-fast: OpenRouter 500 → route returns 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/OCR failed/);
  });
});

describe('POST /api/scan/label — per-user rate limit', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('returns 429 after 20 scans within 60 seconds and includes Retry-After header', async () => {
    // Use a second user (ALEX) so this test's calls do not bleed into the
    // other describe block's MARCUS-keyed bucket.
    const { token } = await loginAs(ALEX);

    // Fire 20 successful stubs to saturate the window.
    for (let i = 0; i < 20; i++) {
      const r = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token });
      expect(r.status).toBe(200);
    }

    // The 21st call should hit the rate limiter.
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token });
    expect(r.status).toBe(429);
    expect((r.body as { error: string }).error).toMatch(/Too many scans/);
    expect(r.headers.get('retry-after')).not.toBeNull();
  });
});
