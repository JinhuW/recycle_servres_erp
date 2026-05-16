import app from '../../src/index';
import { TEST_DATABASE_URL } from './db';
import type { Env } from '../../src/types';

export const testEnv: Env = {
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-' + Math.random().toString(36).slice(2),
  JWT_ISSUER: 'recycle-erp-test',
};

export type ApiResult<T = unknown> = {
  status: number;
  body: T;
  headers: Headers;
};

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; env?: Partial<Env> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const env = opts.env ? { ...testEnv, ...opts.env } : testEnv;
  const res = await app.fetch(new Request('http://test' + path, init), env);
  const text = await res.text();
  let body: T;
  try { body = text ? JSON.parse(text) : (undefined as T); }
  catch { body = text as unknown as T; }
  return { status: res.status, body, headers: res.headers };
}

export async function multipart(
  path: string,
  fields: Record<string, string | Blob>,
  opts: { token?: string; env?: Partial<Env> } = {},
): Promise<ApiResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const env = opts.env ? { ...testEnv, ...opts.env } : testEnv;
  const res = await app.fetch(
    new Request('http://test' + path, { method: 'POST', body: form, headers }),
    env,
  );
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
