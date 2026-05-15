// Tiny fetch wrapper with bearer-token auth. The Vite dev proxy forwards
// /api/* to the Worker on :8787 (see vite.config.ts), so paths stay relative
// in dev and prod.

import type { Category } from './types';

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
  meta?: { warehouseId?: string; payment?: 'company' | 'self'; notes?: string },
) => api.post<{ id: string }>('/api/orders/draft', { category, ...meta });

// Promote a single draft line to a confirmed inventory product.
export const confirmOrderLine = (orderId: string, lineId: string) =>
  api.patch<{ ok: true }>(`/api/orders/${orderId}`, {
    lines: [{ id: lineId, status: 'In Transit' }],
  });

export const deleteOrder = (orderId: string) =>
  api.delete<{ ok: true }>(`/api/orders/${orderId}`);
