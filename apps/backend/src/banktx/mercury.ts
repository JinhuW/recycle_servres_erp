// Mercury bank API client — docs.mercury.com/reference. Simple bearer token,
// GET /api/v1/accounts then per-account GET /api/v1/account/:id/transactions.
// Wire shapes declared from the docs; every number passes through num()
// (providers wire numbers as strings).

import type { Env } from '../types';
import { PAYPAL_TXN_STRICT } from '../ai/paypal';
import { log } from '../lib/log';
import type {
  BankAccountInfo, BankFetch, BankProvider, BankTxnCategory, KnownAccounts, NormalizedTxn, SettleStatus,
} from './types';

const DEFAULT_BASE = 'https://api.mercury.com';
const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;

type WireAccount = { id: string; name?: string | null; nickname?: string | null };
// The IO card is not in /accounts — /credit lists it, unnamed, and its
// transactions come from the same per-account endpoint.
type WireCreditAccount = { id: string; status?: string };
type WireTxn = {
  id: string;
  amount: number | string;
  kind?: string;
  status?: string;
  createdAt?: string;
  postedAt?: string | null;
  counterpartyId?: string | null;
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
function paypalTxnFromDescription(text: string | null): string | null {
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

// A counterparty that is one of our own Mercury accounts is internal too. The
// IO card payoff is kind 'other' on both sides (checking pays "Mercury
// Credit", the card receives from checking); once the card's own charges are
// synced, counting the payoff as well would count that spend twice.
export function mercuryTxnCategory(
  kind: string | undefined,
  description: string | null,
  counterpartyId?: string | null,
  ownAccountIds?: ReadonlySet<string>,
): BankTxnCategory {
  if (kind === 'internalTransfer' || kind === 'treasuryTransfer') return 'transfer';
  if (counterpartyId && ownAccountIds?.has(counterpartyId)) return 'transfer';
  return description && PAYPAL_ACH_DESCRIPTOR.test(description) ? 'transfer' : 'external';
}

// Mercury documents six: pending, sent, cancelled, failed, reversed, blocked.
// The last two are the ones easily missed — leaving them out would have let
// real money movement fall to the unknown-value default below.
//
// Anything unrecognised maps to 'pending' for the same reason PayPal's does:
// an unseen state should be shown and treated as in flight, not hidden.
export function mercurySettleStatus(status: string | undefined): SettleStatus {
  return status === 'sent' ? 'settled'
    : status === 'cancelled' || status === 'failed' || status === 'blocked' ? 'failed'
    : status === 'reversed' ? 'reversed'
    : 'pending';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
    async fetchSince(sinceIso: string, known?: KnownAccounts): Promise<BankFetch> {
      // Card spend must not cost us the bank feed: a token without credit
      // access (or a /credit outage) fails only this part.
      const [{ accounts: wireAccounts }, credit] = await Promise.all([
        call<{ accounts: WireAccount[] }>(env, '/api/v1/accounts', {}),
        call<{ accounts: WireCreditAccount[] }>(env, '/api/v1/credit', {}).then(
          (r) => r.accounts ?? [],
          (e: unknown) => {
            log.warn('mercury credit accounts unavailable', { module: 'banktx', error: errorText(e) });
            return [];
          },
        ),
      ]);
      const bankAccounts: BankAccountInfo[] = wireAccounts.map((a) => ({
        externalId: a.id,
        name: a.nickname ?? a.name ?? null,
      }));
      // A card we already hold keeps syncing once it is frozen or closed: its
      // pending charges still have to resolve. One never active is not ours
      // to start on.
      const cards: BankAccountInfo[] = credit
        .filter((a) => a.status === 'active' || known?.since.has(a.id))
        .map((a) => ({ externalId: a.id, name: 'Mercury Credit' }));
      // Known accounts count as ours even when this run could not list them,
      // or a /credit blip would turn every payoff in the window back into
      // money out.
      const ownIds = new Set([
        ...bankAccounts.map((a) => a.externalId), ...cards.map((a) => a.externalId), ...(known?.since.keys() ?? []),
      ]);

      const fetchAccount = async (account: BankAccountInfo): Promise<NormalizedTxn[]> => {
        const since = known ? known.since.get(account.externalId) ?? known.newSince : sinceIso;
        const start = since.slice(0, 10); // Mercury filters by date
        const txns: NormalizedTxn[] = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const page = await call<{ transactions: WireTxn[] }>(
            env,
            `/api/v1/account/${encodeURIComponent(account.externalId)}/transactions`,
            { start, limit: String(PAGE_SIZE), offset: String(offset), order: 'desc' },
          );
          const rows = page.transactions ?? [];
          for (const t of rows) {
            const amount = num(t.amount);
            // A pending row has no postedAt — it has not posted. Dating it by
            // creation is what puts it in the feed at all, and is the date the
            // page then shows as "pending since".
            const when = t.postedAt ?? t.createdAt;
            if (!t.id || amount === null || !when) continue;
            const description = t.bankDescription ?? t.note ?? t.externalMemo ?? null;
            txns.push({
              source: 'mercury',
              externalId: t.id,
              accountExternalId: account.externalId,
              postedAt: new Date(when),
              amount,
              counterparty: t.counterpartyName ?? t.counterpartyNickname ?? null,
              description,
              paypalTxnId: paypalTxnFromDescription(
                [t.counterpartyName, description].filter(Boolean).join(' ') || null,
              ),
              category: mercuryTxnCategory(t.kind, description, t.counterpartyId, ownIds),
              settleStatus: mercurySettleStatus(t.status),
              raw: t,
            });
          }
          if (rows.length < PAGE_SIZE) break;
        }
        return txns;
      };

      const accounts = [...bankAccounts];
      const txns: NormalizedTxn[] = [];
      for (const account of bankAccounts) txns.push(...await fetchAccount(account));
      // A card that fails is left out whole — rows and account — so its cursor
      // stays put and the next run retries the same window.
      for (const card of cards) {
        try {
          txns.push(...await fetchAccount(card));
          accounts.push(card);
        } catch (e) {
          log.warn('mercury credit transactions unavailable', { module: 'banktx', account: card.externalId, error: errorText(e) });
        }
      }
      return { accounts, txns };
    },
  };
}
