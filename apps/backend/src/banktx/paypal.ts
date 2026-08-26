// PayPal Transaction Search client — developer.paypal.com/docs/api/transaction-search/v1.
// OAuth client credentials with a cached, single-flighted token (the
// ShipSaving shape). The API caps each request at a 31-day window, so a long
// range is fetched in chunks.

import type { Env } from '../types';
import type { BankFetch, BankProvider, BankTxnCategory, NormalizedTxn } from './types';

const DEFAULT_BASE = 'https://api-m.paypal.com';
const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
// Tokens report ~9h expiry; refresh with generous headroom.
const TOKEN_HEADROOM_MS = 5 * 60 * 1000;

type WireTxn = {
  transaction_info?: {
    transaction_id?: string;
    transaction_event_code?: string;
    transaction_status?: string;
    transaction_initiation_date?: string;
    transaction_subject?: string | null;
    transaction_note?: string | null;
    transaction_amount?: { currency_code?: string; value?: string };
  };
  payer_info?: {
    email_address?: string | null;
    payer_name?: {
      alternate_full_name?: string | null;
      given_name?: string | null;
      surname?: string | null;
    };
  };
};

const tokenCache = new Map<string, { token: string; expires: number }>();
const mintInFlight = new Map<string, Promise<string>>();

function base(env: Env): string {
  return (env.PAYPAL_API_URL ?? DEFAULT_BASE).replace(/\/$/, '');
}

function mintToken(env: Env): Promise<string> {
  const key = env.PAYPAL_CLIENT_ID ?? '';
  const inFlight = mintInFlight.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    const res = await fetch(`${base(env)}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${key}:${env.PAYPAL_CLIENT_SECRET ?? ''}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error?: string }
      | null;
    if (!res.ok || !body?.access_token) {
      throw new Error(`paypal oauth2/token failed: HTTP ${res.status} ${body?.error ?? ''}`.trim());
    }
    const ttlMs = Math.max((body.expires_in ?? 0) * 1000 - TOKEN_HEADROOM_MS, 60_000);
    tokenCache.set(key, { token: body.access_token, expires: Date.now() + ttlMs });
    return body.access_token;
  })().finally(() => mintInFlight.delete(key));
  mintInFlight.set(key, p);
  return p;
}

async function getToken(env: Env): Promise<string> {
  const cached = tokenCache.get(env.PAYPAL_CLIENT_ID ?? '');
  if (cached && cached.expires > Date.now()) return cached.token;
  return mintToken(env);
}

async function listPage(env: Env, query: Record<string, string>): Promise<{ rows: WireTxn[]; totalPages: number }> {
  const token = await getToken(env);
  const res = await fetch(`${base(env)}/v1/reporting/transactions?${new URLSearchParams(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`paypal GET /v1/reporting/transactions failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  const body = (await res.json()) as { transaction_details?: WireTxn[]; total_pages?: number };
  return { rows: body.transaction_details ?? [], totalPages: body.total_pages ?? 1 };
}

// T03xx = bank deposit into PayPal, T04xx = withdrawal back to a bank —
// internal transfers, never seller money. Everything else is external.
export function paypalTxnCategory(eventCode: string | undefined): BankTxnCategory {
  return eventCode && /^T0[34]/.test(eventCode) ? 'transfer' : 'external';
}

function counterpartyOf(t: WireTxn): string | null {
  const name = t.payer_info?.payer_name;
  return (
    name?.alternate_full_name
    ?? [name?.given_name, name?.surname].filter(Boolean).join(' ')
    ?? null
  ) || (t.payer_info?.email_address ?? null);
}

export function paypalProvider(env: Env): BankProvider {
  return {
    source: 'paypal',
    async fetchSince(sinceIso: string): Promise<BankFetch> {
      const txns: NormalizedTxn[] = [];
      const end = Date.now();
      for (let from = new Date(sinceIso).getTime(); from < end; from += WINDOW_MS) {
        const windowEnd = Math.min(from + WINDOW_MS, end);
        for (let page = 1; ; page++) {
          const { rows, totalPages } = await listPage(env, {
            start_date: new Date(from).toISOString(),
            end_date: new Date(windowEnd).toISOString(),
            fields: 'transaction_info,payer_info',
            page_size: String(PAGE_SIZE),
            page: String(page),
          });
          for (const t of rows) {
            const info = t.transaction_info;
            // 'S' = settled money movement; pending ('P') rows re-arrive via
            // the cursor overlap once they settle, denied/reversed never do.
            if (!info?.transaction_id || info.transaction_status !== 'S') continue;
            const amount = Number(info.transaction_amount?.value);
            if (!Number.isFinite(amount) || !info.transaction_initiation_date) continue;
            const externalId = info.transaction_id.toUpperCase();
            txns.push({
              source: 'paypal',
              externalId,
              accountExternalId: 'primary',
              postedAt: new Date(info.transaction_initiation_date),
              amount,
              counterparty: counterpartyOf(t),
              description: info.transaction_subject ?? info.transaction_note ?? null,
              paypalTxnId: externalId,
              category: paypalTxnCategory(info.transaction_event_code),
              raw: t,
            });
          }
          if (page >= totalPages) break;
        }
      }
      return { accounts: [{ externalId: 'primary', name: 'PayPal' }], txns };
    },
  };
}
