import { Hono } from 'hono';
import { PERF_PAGES } from '@recycle-erp/shared';
import { log } from '../lib/log';
import { recordPerf } from '../lib/perf';
import { createRateLimiter } from '../lib/rate-limit';
import type { Env, User } from '../types';

// Where the browser says how long the load actually took.
//
// The sibling of routes/clientErrors.ts: that one records what broke, this one
// records what it cost. The backend's own request log has always shown fast
// handlers — 20-60 ms typically — which is exactly why it could not answer "the
// page feels slow": the wait is in the bundle, the round trips, and the paint,
// none of which the server ever sees. Without this the only evidence available
// is someone saying it felt slow, which is how the original report arrived.
//
// Authenticated, like client errors, and for the same reason: an unauthenticated
// write surface into the operator's log is a spam target.

const clientTimings = new Hono<{
  Bindings: Env;
  Variables: { user: User; requestId: string };
}>();

// One report per page load is the design, so this only has to catch a client
// that has lost the plot — a reload loop, or a tampered-with build.
const rateLimited = createRateLimiter(60_000, 20);

// Every field is a millisecond count or a small enum. Anything that could carry
// a URL is deliberately absent: this endpoint must never become a second place
// a URL-borne token can land in the log.
const MAX_MS = 10 * 60_000;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS
    ? Math.round(v)
    : undefined;

const NAV_TYPES = ['navigate', 'reload', 'back_forward', 'prerender'] as const;
const navType = (v: unknown): string | undefined =>
  typeof v === 'string' && (NAV_TYPES as readonly string[]).includes(v) ? v : undefined;

// Closed sets, so neither can carry a URL into the log or a rollup's name.
const shellOf = (v: unknown): string => (v === 'desktop' || v === 'mobile' ? v : 'unknown');
const pageOf = (v: unknown): string =>
  typeof v === 'string' && (PERF_PAGES as readonly string[]).includes(v) ? v : 'other';

type Body = {
  ttfb?: unknown; domContentLoaded?: unknown; loadEvent?: unknown; lcp?: unknown;
  navType?: unknown; apiCalls?: unknown; refreshes?: unknown; downlink?: unknown;
  shell?: unknown; page?: unknown;
};

clientTimings.post('/', async (c) => {
  const u = c.var.user;

  const retryAfter = rateLimited(u.id);
  if (retryAfter !== null) {
    return c.json({ error: 'Too many reports' }, 429, { 'Retry-After': String(retryAfter) });
  }

  const body = await c.req.json<Body>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required' }, 400);

  const loadEvent = num(body.loadEvent);
  // The one field worth requiring: without it there is no load to talk about,
  // and a report of nothing but counters would skew every percentile drawn
  // from this stream.
  if (loadEvent === undefined) return c.json({ error: 'loadEvent is required' }, 400);

  const ttfb = num(body.ttfb);
  const lcp = num(body.lcp);
  const nav = navType(body.navType);
  const shell = shellOf(body.shell);
  const page = pageOf(body.page);

  // Real loads only: a back_forward load comes out of the bfcache and a
  // prerender was never waited on, so either would flatter the percentiles.
  if (nav === 'navigate' || nav === 'reload') {
    // A page hidden before its load event reports 0: not an instant load but an
    // unfinished one, usually a slow one the user gave up watching.
    if (loadEvent > 0) recordPerf('client', `load|${shell}|${page}`, loadEvent);
    if (ttfb !== undefined) recordPerf('client', `ttfb|${shell}|${page}`, ttfb);
    if (lcp !== undefined) recordPerf('client', `lcp|${shell}|${page}`, lcp);
  }

  // log.info, not warn: this is the healthy path. It rides the same ambient
  // requestId and release stamp as every other line, so a slow load can be
  // joined to the requests it made.
  log.info('client timing', {
    kind: 'client-timing',
    userEmail: u.email,
    shell,
    page,
    ttfb,
    domContentLoaded: num(body.domContentLoaded),
    loadEvent,
    lcp,
    navType: nav,
    apiCalls: num(body.apiCalls),
    refreshes: num(body.refreshes),
    downlink: typeof body.downlink === 'number' && Number.isFinite(body.downlink)
      ? body.downlink : undefined,
  });

  return c.body(null, 204);
});

export default clientTimings;
