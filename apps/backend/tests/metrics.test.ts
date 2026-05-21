import { describe, it, expect, beforeAll } from 'vitest';
import { api } from './helpers/app';
import { resetDb } from './helpers/db';

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
    const env = { DATABASE_URL: process.env.DATABASE_URL! } as never;
    await scanLabel(env, 'RAM', new ArrayBuffer(8));
    await scanLabel(env, 'RAM', new ArrayBuffer(8));

    const r = await api<string>('GET', '/metrics');
    const body = r.body as unknown as string;
    expect(body).toMatch(/ocr_calls_total\{[^}]*provider="stub"[^}]*outcome="stub"[^}]*\}\s+\d+/);
  });
});
