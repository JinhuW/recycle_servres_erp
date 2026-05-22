import app from '../../src/index';
import { TEST_DATABASE_URL } from './db';
import type { Env } from '../../src/types';

// Re-read OAUTH_DCR_OPEN from process.env on every access so tests that flip
// the gate via `process.env.OAUTH_DCR_OPEN = 'true'` see their mutation.
const TEST_ENV_BASE = {
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-' + Math.random().toString(36).slice(2),
  JWT_ISSUER: 'recycle-erp-test',
  OAUTH_ISSUER_URL: 'http://localhost:8787',
};
export const testEnv: Env = new Proxy(TEST_ENV_BASE as Env, {
  get(target, prop, receiver) {
    if (prop === 'OAUTH_DCR_OPEN') return process.env.OAUTH_DCR_OPEN;
    return Reflect.get(target, prop, receiver);
  },
});

export type ApiResult<T = unknown> = {
  status: number;
  body: T;
  headers: Headers;
  setCookies: Record<string, string>;
};

export type ApiOptions = {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  env?: Partial<Env>;
};

export type MultipartOptions = {
  token?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  env?: Partial<Env>;
};

// Case-insensitive lookup over a plain header record.
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

// Merge a `cookies` record into any caller-provided Cookie header (caller cookies kept).
function applyCookies(headers: Record<string, string>, cookies?: Record<string, string>): void {
  if (!cookies || Object.keys(cookies).length === 0) return;
  const extra = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  const existing = getHeader(headers, 'Cookie');
  const merged = (existing ? [existing, ...extra] : extra).join('; ');
  // Reuse the caller's original casing if they set one; otherwise default to `Cookie`.
  let key = 'Cookie';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'cookie') { key = k; break; }
  }
  headers[key] = merged;
}

// From a (possibly comma-joined) Set-Cookie string, take each cookie's first name=value.
function parseSetCookies(setCookie: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!setCookie) return out;
  // Split on commas that separate cookies, not commas inside Expires=...,
  // by splitting on `, ` that precedes a `name=` token.
  const parts = setCookie.split(/,(?=\s*[^=;,\s]+=)/);
  for (const part of parts) {
    const first = part.split(';')[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  // Default CSRF header unless the caller already provided it (caller override wins).
  if (!hasHeader(headers, 'X-Requested-By')) headers['X-Requested-By'] = 'recycle-erp';
  // Cookie-only auth: the legacy `token` option is delivered as the `at` cookie
  // (merged alongside any opts.cookies / caller Cookie header — never clobbered).
  applyCookies(headers, opts.token ? { at: opts.token } : undefined);
  applyCookies(headers, opts.cookies);

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const env = opts.env ? { ...testEnv, ...opts.env } : testEnv;
  const res = await app.fetch(new Request('http://test' + path, init), env);
  const text = await res.text();
  let body: T;
  try { body = text ? JSON.parse(text) : (undefined as T); }
  catch { body = text as unknown as T; }
  return {
    status: res.status,
    body,
    headers: res.headers,
    setCookies: parseSetCookies(res.headers.get('set-cookie')),
  };
}

export async function multipart(
  path: string,
  fields: Record<string, string | Blob>,
  opts: MultipartOptions = {},
): Promise<ApiResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!hasHeader(headers, 'X-Requested-By')) headers['X-Requested-By'] = 'recycle-erp';
  applyCookies(headers, opts.token ? { at: opts.token } : undefined);
  applyCookies(headers, opts.cookies);
  const env = opts.env ? { ...testEnv, ...opts.env } : testEnv;
  const res = await app.fetch(
    new Request('http://test' + path, { method: 'POST', body: form, headers }),
    env,
  );
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {
    status: res.status,
    body,
    headers: res.headers,
    setCookies: parseSetCookies(res.headers.get('set-cookie')),
  };
}
