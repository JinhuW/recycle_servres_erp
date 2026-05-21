// Prometheus metrics for the Hono backend.
//
// One process-wide Registry. Default Node.js metrics (heap, GC, eventloop
// lag) plus an HTTP-duration histogram and an OCR counter. Route labels
// come from Hono's matched-pattern (`c.req.routePath`), NOT the raw URL —
// otherwise every order ID would mint a fresh series and blow up
// cardinality on the remote Prometheus.

import type { Context, Next } from 'hono';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labeled by Hono matched route.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served, labeled by Hono matched route.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const ocrCallsTotal = new Counter({
  name: 'ocr_calls_total',
  help: 'OCR scan attempts. outcome ∈ {ok, error, stub}.',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

// Hono middleware: times every request and records the result.
// Must run after request-id/CORS but before route handlers so the matched
// route pattern is available when next() returns.
export async function metricsMiddleware(c: Context, next: Next): Promise<void> {
  const start = process.hrtime.bigint();
  try {
    await next();
  } finally {
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const seconds = elapsedNs / 1e9;
    // c.req.routePath is the matched Hono pattern (e.g. "/api/orders/:id").
    // For requests that match only a catch-all middleware (e.g. true 404s)
    // it returns "*"; defended with || 'unmatched' in case Hono ever changes
    // that contract. Either way the label cardinality stays bounded.
    const route = c.req.routePath || 'unmatched';
    const status = String(c.res.status);
    const labels = { method: c.req.method, route, status };
    httpRequestDuration.observe(labels, seconds);
    httpRequestsTotal.inc(labels);
  }
}

// /metrics handler: serializes the registry in Prometheus exposition format.
export async function metricsHandler(c: Context): Promise<Response> {
  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': registry.contentType },
  });
}
