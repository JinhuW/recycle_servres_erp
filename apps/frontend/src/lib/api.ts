// Tiny fetch wrapper with bearer-token auth. The Vite dev proxy forwards
// /api/* to the backend on :8787 (see vite.config.ts); in prod Caddy proxies
// /api/* to the backend. Either way paths stay relative.

import type { Category, OrderSummary } from './types';

const TOKEN_KEY = 'recycle_erp_token';

export const auth = {
  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set token(value: string | null) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { isForm?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (opts.isForm) {
      payload = body as FormData;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  const res = await fetch(path, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? safeJson(text) : null;

  if (!res.ok) {
    const msg = (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string')
      ? json.error
      : `HTTP ${res.status}`;
    // A 401 on any call other than the login attempt itself means the token
    // expired or was revoked mid-session. Clear it and signal the app so the
    // AuthProvider drops to the login screen instead of every component
    // silently swallowing the error and showing stale/empty data.
    if (res.status === 401 && !path.includes('/api/auth/login')) {
      auth.token = null;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
    }
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export const api = {
  get:    <T,>(path: string)              => request<T>('GET', path),
  post:   <T,>(path: string, body: unknown) => request<T>('POST', path, body),
  put:    <T,>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch:  <T,>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T,>(path: string)              => request<T>('DELETE', path),
  upload: <T,>(path: string, form: FormData) => request<T>('POST', path, form, { isForm: true }),
};

export const createDraftOrder = (
  category: Category,
  meta?: { warehouseId?: string; payment?: OrderSummary['payment']; notes?: string },
) => api.post<{ id: string }>('/api/orders/draft', { category, ...meta });

export const deleteOrder = (orderId: string) =>
  api.delete<{ ok: true }>(`/api/orders/${orderId}`);
