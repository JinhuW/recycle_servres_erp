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
