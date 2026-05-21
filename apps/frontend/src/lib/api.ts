// Tiny fetch wrapper with cookie-based auth. The backend sets httpOnly
// `at`/`rt` cookies on login/refresh/logout; we never see tokens in JS.
// Every state-changing request carries the `X-Requested-By` CSRF header and
// `credentials: 'include'`. The Vite dev proxy forwards /api/* to the backend
// on :8787 (see vite.config.ts); in prod Caddy proxies /api/* to the backend.
// Either way paths stay relative (same-origin), so cookies ride along.

import type { Category, OrderSummary } from './types';

const CSRF_HEADER = 'X-Requested-By';
const CSRF_VALUE = 'recycle-erp';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Single-flight refresh: while a refresh is in flight, concurrent 401s await
// the same promise instead of stampeding the refresh endpoint.
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: { [CSRF_HEADER]: CSRF_VALUE },
        });
        return res.ok;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function doFetch(method: string, path: string, opts: { isForm?: boolean }, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_VALUE };

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (opts.isForm) {
      payload = body as FormData;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  return fetch(path, { method, headers, body: payload, credentials: 'include' });
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { isForm?: boolean } = {},
): Promise<T> {
  let res = await doFetch(method, path, opts, body);

  // A 401 on any call other than the refresh endpoint itself means the access
  // cookie expired. Silently refresh once, then retry the original request a
  // single time. The refresh call never recurses into this logic.
  if (res.status === 401 && !path.includes('/api/auth/refresh')) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch(method, path, opts, body);
    }
    if (res.status === 401) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      throw new ApiError(401, errMsg(json, 401));
    }
  }

  const text = await res.text();
  const json = text ? safeJson(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, errMsg(json, res.status));
  }
  return json as T;
}

function errMsg(json: unknown, status: number): string {
  return (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string')
    ? json.error
    : `HTTP ${status}`;
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
