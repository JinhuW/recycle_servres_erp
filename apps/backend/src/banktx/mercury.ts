// Mercury bank API client — docs.mercury.com/reference. Simple bearer token,
// GET /api/v1/accounts then per-account GET /api/v1/account/:id/transactions.
// Wire shapes declared from the docs; every number passes through num() (the
// ShipSaving lesson: providers wire numbers as strings).

import type { Env } from '../types';
import { PAYPAL_TXN_STRICT } from '../ai/paypal';
import type { BankAccountInfo, BankFetch, BankProvider, BankTxnCategory, NormalizedTxn } from './types';

const DEFAULT_BASE = 'https://api.mercury.com';
const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;

type WireAccount = { id: string; name?: string | null; nickname?: string | null };
type WireTxn = {
  id: string;
  amount: number | string;
  kind?: string;
  status?: string;
  createdAt?: string;
  postedAt?: string | null;
  counterpartyName?: string | null;
  counterpartyNickname?: string | null;
  bankDescription?: string | null;
  note?: string | null;
  externalMemo?: string | null;
};

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// A Mercury settlement of a PayPal transfer sometimes carries the PayPal
// transaction id in the bank description. Only trust a 17-char token when the
// text actually mentions PayPal — bare alphanumeric runs false-positive on
// ACH trace numbers.
export function paypalTxnFromDescription(text: string | null): string | null {
  if (!text || !/paypal/i.test(text)) return null;
  const m = text.toUpperCase().match(/\b[A-Z0-9]{17}\b/);
  return m && PAYPAL_TXN_STRICT.test(m[0]) ? m[0] : null;
}

// Moves between the company's own Mercury accounts (and treasury sweeps) are
// internal by definition, and so are ACH moves against our own PayPal balance
// — those carry the "PAYPAL; <type>; <account holder>" descriptor. Card
// purchases at PayPal merchants descriptor as "PAYPAL *name" and stay
// external (they settle real vendor payments). A wire from a sibling company
// is NOT identifiable here — those are taught per-counterparty
// (bank_transfer_counterparties).
// Exported because transfer-pairing has to tell *why* a Mercury leg is a
// transfer: this descriptor says the sibling is on PayPal, every other reason
// says it is elsewhere.
export const PAYPAL_ACH_DESCRIPTOR = /^PAYPAL;/;

export function mercuryTxnCategory(kind: string | undefined, description: string | null): BankTxnCategory {
  if (kind === 'internalTransfer' || kind === 'treasuryTransfer') return 'transfer';
  return description && PAYPAL_ACH_DESCRIPTOR.test(description) ? 'transfer' : 'external';
}

async function call<T>(env: Env, path: string, query: Record<string, string>): Promise<T> {
  const base = (env.MERCURY_API_URL ?? DEFAULT_BASE).replace(/\/$/, '');
  const qs = Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${base}${path}${qs}`, {
    headers: { Authorization: `Bearer ${env.MERCURY_API_TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`mercury GET ${path} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  return res.json() as Promise<T>;
}

export function mercuryProvider(env: Env): BankProvider {
  return {
    source: 'mercury',
    async fetchSince(sinceIso: string): Promise<BankFetch> {
      const { accounts: wireAccounts } = await call<{ accounts: WireAccount[] }>(env, '/api/v1/accounts', {});
      const accounts: BankAccountInfo[] = wireAccounts.map((a) => ({
        externalId: a.id,
        name: a.nickname ?? a.name ?? null,
      }));

      const start = sinceIso.slice(0, 10); // Mercury filters by date
      const txns: NormalizedTxn[] = [];
      for (const account of wireAccounts) {
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const page = await call<{ transactions: WireTxn[] }>(
            env,
            `/api/v1/account/${encodeURIComponent(account.id)}/transactions`,
            { start, limit: String(PAGE_SIZE), offset: String(offset), order: 'desc' },
          );
          const rows = page.transactions ?? [];
          for (const t of rows) {
            // Pending rows have no posted date and re-arrive once sent; the
            // cursor overlap picks them up then. Failed/cancelled never post.
            if (t.status !== 'sent') continue;
            const amount = num(t.amount);
            const when = t.postedAt ?? t.createdAt;
            if (!t.id || amount === null || !when) continue;
            const description = t.bankDescription ?? t.note ?? t.externalMemo ?? null;
            txns.push({
              source: 'mercury',
              externalId: t.id,
              accountExternalId: account.id,
              postedAt: new Date(when),
              amount,
              counterparty: t.counterpartyName ?? t.counterpartyNickname ?? null,
              description,
              paypalTxnId: paypalTxnFromDescription(
                [t.counterpartyName, description].filter(Boolean).join(' ') || null,
              ),
              category: mercuryTxnCategory(t.kind, description),
              raw: t,
            });
          }
          if (rows.length < PAGE_SIZE) break;
        }
      }
      return { accounts, txns };
    },
  };
}
