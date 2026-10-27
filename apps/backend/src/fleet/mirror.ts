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

export const forwardsReads = (env: Env): boolean =>
  !!(env.FLEET_MIRROR_URL && env.FLEET_MIRROR_CLIENT_ID && env.FLEET_MIRROR_CLIENT_SECRET);

const base = (env: Env): string => env.FLEET_MIRROR_URL!.replace(/\/+$/, '');

async function mirrorToken(env: Env): Promise<string | null> {
  const key = `${base(env)} ${env.FLEET_MIRROR_CLIENT_ID}`;
  if (cached?.key === key && cached.until > Date.now()) return cached.token;
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
  const body = await res.json() as { access_token: string; expires_in: number };
  cached = { key, token: body.access_token, until: Date.now() + body.expires_in * 1000 - EARLY_MS };
  return body.access_token;
}

const unreachable = () => Response.json({ error: 'mirror_unreachable', detail: 'the ERP the fleet runs on did not answer' }, { status: 502 });

/** The fleet's own answer to this read, status and body as they came. */
export async function forwardRead(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let res: Response;
  try {
    const token = await mirrorToken(env);
    if (!token) return unreachable();
    res = await fetch(`${base(env)}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unreachable();
  }
  // A revoked client or a rotated signing key: take a fresh token next time.
  if (res.status === 401 || res.status === 403) {
    cached = null;
    mlog.warn('fleet mirror read refused', { upstreamStatus: res.status, upstreamPath: url.pathname });
    return unreachable();
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Tests only: forget the cached token. */
export const resetMirrorToken = (): void => { cached = null; };
