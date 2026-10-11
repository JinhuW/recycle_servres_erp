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

  it('SSD category: stub extraction returns SSD fields and persists with category SSD', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'SSD' }, { token });
    expect(r.status).toBe(200);
    const body = r.body as { provider: string; extracted: Record<string, string> };
    expect(body.provider).toBe('stub');
    expect(body.extracted.interface).toBe('NVMe');
    expect(body.extracted.formFactor).toBe('M.2 22110');
    expect(body.extracted.partNumber).toBe('MZ1L21T9HCLS-00A07');
    const sql = getTestDb();
    const rows = await sql`SELECT provider FROM label_scans WHERE category = 'SSD'`;
    expect(rows.length).toBe(1);
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
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/OCR failed/);
    // An HTTP error is not a transient — a second attempt fails the same way,
    // so only a timeout is retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Seen once in production: a purchaser waited 20s over a RAM stick, got an
  // error dialog, re-shot the same label and it came back in 2s. The retry
  // belongs on this side of the phone.
  it('retries once when the model times out, and succeeds on the second attempt', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"brand":"Micron"}' } }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(200);
    expect((r.body as { extracted: Record<string, string> }).extracted.brand).toBe('Micron');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry also times out, and still answers 502', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchMock);
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(502);
    // Two attempts, not four: the retry does not compound with the JSON re-ask.
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe('POST /api/scan/label — part # cross-check', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  const scanWith = async (fields: Record<string, string>) => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...fields, _confidence: 0.9 }) } }] }), { status: 200 }),
    ));
    const { token } = await loginAs(MARCUS);
    return multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token, env: { OPENROUTER_API_KEY: 'test-key' } });
  };
  type Body = { extracted: Record<string, string>; partCheck?: { partCorrected?: { from: string; to: string }; filled: string[]; conflicts: { field: string }[] } };

  it('corrects a misread part # the printed specs agree with, and stores what the model read', async () => {
    const r = await scanWith({
      brand: 'SK Hynix', capacity: '32GB', generation: 'DDR4', type: 'Server',
      classification: 'RDIMM', rank: '2Rx8', speed: '3200', partNumber: 'HMA84GR7AJR8N-XN',
    });
    expect(r.status).toBe(200);
    const body = r.body as Body;
    expect(body.extracted.partNumber).toBe('HMAA4GR7AJR8N-XN');
    expect(body.partCheck?.partCorrected?.from).toBe('HMA84GR7AJR8N-XN');
    const [row] = await getTestDb()`SELECT extracted FROM label_scans ORDER BY created_at DESC LIMIT 1`;
    expect((row.extracted as Record<string, string>).partNumber).toBe('HMA84GR7AJR8N-XN');
  });

  it('fills what the model skipped and reports what still contradicts', async () => {
    const r = await scanWith({ brand: 'Samsung', capacity: '32GB', partNumber: 'M393A2K40BB1-CRC0Q' });
    const body = r.body as Body;
    expect(body.extracted.rank).toBe('1Rx4');
    expect(body.partCheck?.filled).toContain('rank');
    expect(body.partCheck?.conflicts.map(m => m.field)).toEqual(['capacity']);
  });

  it('leaves SSD scans alone', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'SSD' }, { token });
    expect((r.body as Body).partCheck).toBeUndefined();
  });
});
