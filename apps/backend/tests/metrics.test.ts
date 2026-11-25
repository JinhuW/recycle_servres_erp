import { describe, it, expect, beforeAll } from 'vitest';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { releaseVersion } from '../src/lib/log';
import { resetDb, TEST_DATABASE_URL } from './helpers/db';

describe('GET /metrics', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('returns Prometheus exposition with default + custom metrics', async () => {
    // Hit a known route first so the histogram has something to report.
    await api('GET', '/api/health');
    await api('GET', '/api/health');

    const r = await api<string>('GET', '/metrics');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toMatch(/text\/plain/);
    const body = r.body as unknown as string;

    // Default Node.js metrics are present.
    expect(body).toContain('process_resident_memory_bytes');
    expect(body).toContain('nodejs_eventloop_lag_seconds');

    // Custom HTTP histogram fired for the /api/health calls.
    expect(body).toContain('http_request_duration_seconds_bucket');
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/api\/health"[^}]*\}/);
  });
});

describe('ocr_calls_total counter', () => {
  it('increments on every scanLabel call', async () => {
    // Call the stub provider directly so the test doesn't need a real model.
    const { scanLabel } = await import('../src/ai');
    const env = { DATABASE_URL: TEST_DATABASE_URL } as never;
    await scanLabel(env, 'RAM', new ArrayBuffer(8));
    await scanLabel(env, 'RAM', new ArrayBuffer(8));

    const r = await api<string>('GET', '/metrics');
    const body = r.body as unknown as string;
    expect(body).toMatch(/ocr_calls_total\{[^}]*provider="stub"[^}]*outcome="stub"[^}]*\}\s+\d+/);
  });
});

describe('/metrics access', () => {
  const token = 'scrape-token-for-tests';

  it('serves the scraper that presents the token', async () => {
    const r = await api<string>('GET', '/metrics', {
      env: { METRICS_TOKEN: token }, headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
  });

  it('refuses a missing or wrong token', async () => {
    const none = await api('GET', '/metrics', { env: { METRICS_TOKEN: token } });
    expect(none.status).toBe(401);
    const wrong = await api('GET', '/metrics', {
      env: { METRICS_TOKEN: token }, headers: { Authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
  });

  it('serves nothing in production without a token', async () => {
    const r = await api('GET', '/metrics', { env: { NODE_ENV: 'production', METRICS_TOKEN: undefined } });
    expect(r.status).toBe(404);
  });

  it('labels every series with the release', async () => {
    const body = (await api<string>('GET', '/metrics')).body as unknown as string;
    expect(body).toContain(`process_resident_memory_bytes{release="${releaseVersion()}"}`);
  });
});

describe('page-load histograms', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('records real loads by shell and page, and keeps a path out of the labels', async () => {
    const { token } = await loginAs(ALEX);
    const post = (body: object) => api('POST', '/api/client-timings', { token, body });
    expect((await post({ loadEvent: 1200, lcp: 800, ttfb: 90, navType: 'navigate', shell: 'desktop', page: 'inventory' })).status).toBe(204);
    expect((await post({ loadEvent: 700, navType: 'reload', shell: 'mobile', page: '/orders/PO-1234' })).status).toBe(204);
    // A bfcache restore was never waited on.
    expect((await post({ loadEvent: 5, lcp: 5, navType: 'back_forward', shell: 'desktop', page: 'inventory' })).status).toBe(204);

    const body = (await api<string>('GET', '/metrics')).body as unknown as string;
    expect(body).toMatch(/web_page_lcp_seconds_count\{[^}]*shell="desktop"[^}]*page="inventory"[^}]*\} 1\n/);
    expect(body).toMatch(/web_page_ttfb_seconds_sum\{[^}]*page="inventory"[^}]*\} 0\.09\n/);
    expect(body).toMatch(/web_page_load_seconds_count\{[^}]*shell="mobile"[^}]*page="other"[^}]*\} 1\n/);
    expect(body).not.toContain('PO-1234');
  });
});
