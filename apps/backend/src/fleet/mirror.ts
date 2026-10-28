import { log } from '../lib/log';
import type { Env } from '../types';

// ─── Mirror reads ─────────────────────────────────────────────────────────────
// A mirror (FLEET_ROLE=mirror) answers its managers' fleet reads from the ERP
// the fleet runs on, as a service client holding fleet:read there. The caller
// was checked as a manager here first; prod sees only the client.

const mlog = log.child({ module: 'fleet' });

const TIMEOUT_MS = 10_000;
// Taken this long before the token's expiry, so one in flight never lapses.
const EARLY_MS = 60_000;

let cached: { key: string; token: string; until: number } | null = null;
// One mint for every read that finds the cache cold: the Fleet page opens with
// six reads at once.
let minting: { key: string; token: Promise<string | null> } | null = null;

export const forwardsReads = (env: Env): boolean =>
  !!(env.FLEET_MIRROR_URL && env.FLEET_MIRROR_CLIENT_ID && env.FLEET_MIRROR_CLIENT_SECRET);

const base = (env: Env): string => env.FLEET_MIRROR_URL!.replace(/\/+$/, '');

async function mint(env: Env, key: string): Promise<string | null> {
  const res = await fetch(`${base(env)}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.FLEET_MIRROR_CLIENT_ID!,
      client_secret: env.FLEET_MIRROR_CLIENT_SECRET!,
      scope: 'fleet:read',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    mlog.warn('fleet mirror token refused', { upstreamStatus: res.status });
    return null;
  }
  const body = await res.json() as { access_token: string; expires_in?: number };
  // RFC 6749 makes expires_in optional; without it, hold the token five minutes.
  const ttl = Number.isFinite(body.expires_in) && body.expires_in! > 0 ? body.expires_in! : 300;
  cached = { key, token: body.access_token, until: Date.now() + Math.max(ttl * 1000 - EARLY_MS, ttl * 500) };
  return body.access_token;
}

async function mirrorToken(env: Env, fresh = false): Promise<string | null> {
  const key = `${base(env)} ${env.FLEET_MIRROR_CLIENT_ID}`;
  if (!fresh && cached?.key === key && cached.until > Date.now()) return cached.token;
  if (minting?.key !== key) {
    const token = mint(env, key).finally(() => { if (minting?.token === token) minting = null; });
    minting = { key, token };
  }
  return minting.token;
}

/** Whether the fleet's ERP hands this mirror a token: what /health reports as live. */
export async function mirrorAnswers(env: Env): Promise<boolean> {
  try {
    return !!(await mirrorToken(env));
  } catch {
    return false;
  }
}

// Hop-by-hop and framing headers belong to the upstream connection, cookies to
// the upstream origin; everything else (X-Fleet-Truncated, ETag) is the answer.
const DROPPED = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'set-cookie']);

/**
 * The fleet's own answer to this read, status, headers and body as they came,
 * or null when it can't be had (no answer, or a route the fleet's older
 * release lacks): the caller then serves the copy in this database.
 */
export async function forwardRead(env: Env, req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const get = (token: string) => fetch(`${base(env)}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let res: Response;
  try {
    const token = await mirrorToken(env);
    if (!token) return null;
    res = await get(token);
    // invalid_token is the token itself refused (a revoked client, a rotated
    // signing key): one fresh token, once. Any other 401/403 is the route's
    // own answer and goes back as it came.
    if (res.status === 401 && res.headers.get('WWW-Authenticate')?.includes('invalid_token')) {
      const again = await mirrorToken(env, true);
      if (!again) return null;
      res = await get(again);
    }
  } catch (e) {
    mlog.warn('fleet mirror read failed', { upstreamPath: url.pathname, error: (e as Error).message });
    return null;
  }
  if (res.status >= 500) {
    mlog.warn('fleet mirror read failed', { upstreamStatus: res.status, upstreamPath: url.pathname });
    return null;
  }
  // The app-wide 404, not a fleet refusal (those say not_found): the fleet's
  // ERP runs an older release that lacks this read.
  if (res.status === 404) {
    const text = await res.text();
    if (text === JSON.stringify({ error: 'Not found' })) return null;
    return reply(res, text);
  }
  return reply(res, res.body);
}

function reply(res: Response, body: ReadableStream | string | null): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => { if (!DROPPED.has(k)) headers.set(k, v); });
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Fleet-Source', 'live');
  return new Response(body, { status: res.status, headers });
}

/** Tests only: forget the cached token. */
export const resetMirrorToken = (): void => { cached = null; minting = null; };
