// PayPal clients — Transaction Search (developer.paypal.com/docs/api/transaction-search/v1)
// for the money, Customer Disputes (…/customer-disputes/v1) for the cases we
// open against sellers. One OAuth client-credentials token covers both, cached
// and single-flighted (the ShipSaving shape). Transaction Search caps each
// request at a 31-day window, so a long range is fetched in chunks.
//
// Disputes sit behind a separate app permission ("Disputes" under App feature
// options): a token minted without it carries no scope for them and every call
// 403s, which is why the sync treats disputes as independently fallible.

import type { Env } from '../types';
import type {
  BankFetch, BankProvider, BankTxnCategory, DisputeTimelineEntry,
  NormalizedDispute, NormalizedTxn,
} from './types';

const DEFAULT_BASE = 'https://api-m.paypal.com';
const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 500;
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
// Tokens report ~9h expiry; refresh with generous headroom.
const TOKEN_HEADROOM_MS = 5 * 60 * 1000;
// Disputes cap the page at 50 where Transaction Search allows 500, and PayPal
// only serves the last 180 days at all. The page cap guards against a `next`
// link that points back at itself; 1000 cases is not a number this business
// reaches.
const DISPUTE_PAGE_SIZE = 50;
const DISPUTE_MAX_PAGES = 20;

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

async function getJson<T>(env: Env, url: string, path: string): Promise<T> {
  const token = await getToken(env);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`paypal GET ${path} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  return (await res.json()) as T;
}

async function listPage(env: Env, query: Record<string, string>): Promise<{ rows: WireTxn[]; totalPages: number }> {
  const body = await getJson<{ transaction_details?: WireTxn[]; total_pages?: number }>(
    env,
    `${base(env)}/v1/reporting/transactions?${new URLSearchParams(query)}`,
    '/v1/reporting/transactions',
  );
  return { rows: body.transaction_details ?? [], totalPages: body.total_pages ?? 1 };
}

// T03xx = bank deposit into PayPal, T04xx = withdrawal back to a bank,
// T07xx = card deposit into the balance (on our own account that card is
// always our own Mercury debit card funding a payment) — internal transfers,
// never seller money. Everything else is external.
export function paypalTxnCategory(eventCode: string | undefined): BankTxnCategory {
  return eventCode && /^T0[347]/.test(eventCode) ? 'transfer' : 'external';
}

function counterpartyOf(t: WireTxn): string | null {
  const name = t.payer_info?.payer_name;
  return (
    name?.alternate_full_name
    ?? [name?.given_name, name?.surname].filter(Boolean).join(' ')
    ?? null
  ) || (t.payer_info?.email_address ?? null);
}

// ─── Disputes ────────────────────────────────────────────────────────────────

type WireMoney = { currency_code?: string; value?: string };

// What the list call returns. `dispute_state` arrives *only* here — the detail
// document doesn't carry it — which is why both are kept and merged.
type WireDisputeSummary = {
  dispute_id?: string;
  create_time?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_amount?: WireMoney;
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  buyer_response_due_date?: string;
  seller_response_due_date?: string;
};

// The detail document. `disputed_transactions` is the only place the
// transaction id appears, so the second call is not optional. Deliberately
// undeclared: messages, evidences, supporting_info, and the buyer/seller blocks
// inside disputed_transactions — correspondence and counterparty PII we have no
// reason to copy into our database.
type WireDisputeDetail = WireDisputeSummary & {
  disputed_transactions?: { buyer_transaction_id?: string; seller_transaction_id?: string }[];
  dispute_outcome?: { outcome_code?: string; outcome_reason?: string; amount_refunded?: WireMoney };
  adjudications?: {
    type?: string; adjudication_time?: string; reason?: string; dispute_life_cycle_stage?: string;
  }[];
  // `money_movements` is deprecated in favour of `fund_movements`, which renames
  // `affected_party` to `party`. Read whichever the account is still sending.
  fund_movements?: { party?: string; amount?: WireMoney; initiated_time?: string; type?: string; reason?: string }[];
  money_movements?: { affected_party?: string; amount?: WireMoney; initiated_time?: string; type?: string; reason?: string }[];
};

function money(m: WireMoney | undefined): number | null {
  const n = Number(m?.value);
  return Number.isFinite(n) ? n : null;
}

// The case's history as PayPal records it, flattened into one dated list. Pure,
// so the mapping is testable without a wire.
export function disputeTimeline(d: WireDisputeDetail): DisputeTimelineEntry[] {
  const out: DisputeTimelineEntry[] = [];
  if (d.create_time) {
    out.push({
      at: d.create_time, kind: 'opened', code: d.reason ?? null,
      stage: null, party: null, amount: money(d.dispute_amount),
    });
  }
  for (const a of d.adjudications ?? []) {
    if (!a.adjudication_time) continue;
    out.push({
      at: a.adjudication_time, kind: 'adjudication', code: a.type ?? null,
      stage: a.dispute_life_cycle_stage ?? null, party: null, amount: null,
    });
  }
  const moves = d.fund_movements?.length
    ? d.fund_movements
    : (d.money_movements ?? []).map(m => ({ ...m, party: m.affected_party }));
  for (const m of moves) {
    if (!m.initiated_time) continue;
    out.push({
      at: m.initiated_time, kind: 'money', code: m.type ?? null,
      stage: null, party: m.party ?? null, amount: money(m.amount),
    });
  }
  const outcome = d.dispute_outcome?.outcome_code;
  // The outcome carries no timestamp of its own, so the case's last update is
  // when it landed. `NONE` is what an open case reports — not an outcome.
  if (outcome && outcome !== 'NONE' && d.update_time) {
    out.push({
      at: d.update_time, kind: 'outcome', code: outcome, stage: null,
      party: null, amount: money(d.dispute_outcome?.amount_refunded),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function normalizeDispute(
  summary: WireDisputeSummary,
  detail: WireDisputeDetail,
): NormalizedDispute {
  // PayPal issues the payer and the payee different ids for one payment and
  // doesn't say which of ours is which, so both are candidates for the join.
  const txnIds = [...new Set(
    (detail.disputed_transactions ?? [])
      .flatMap(t => [t.buyer_transaction_id, t.seller_transaction_id])
      .filter((x): x is string => !!x)
      .map(x => x.toUpperCase()),
  )];
  const amount = detail.dispute_amount ?? summary.dispute_amount;
  return {
    disputeId: summary.dispute_id ?? '',
    txnIds,
    reason: detail.reason ?? summary.reason ?? null,
    status: detail.status ?? summary.status ?? null,
    disputeState: summary.dispute_state ?? null,
    lifeCycleStage: detail.dispute_life_cycle_stage ?? summary.dispute_life_cycle_stage ?? null,
    channel: detail.dispute_channel ?? summary.dispute_channel ?? null,
    amount: money(amount),
    currency: amount?.currency_code ?? null,
    outcomeCode: detail.dispute_outcome?.outcome_code ?? null,
    refundedAmount: money(detail.dispute_outcome?.amount_refunded),
    openedAt: summary.create_time ?? detail.create_time ?? null,
    updatedAt: detail.update_time ?? summary.update_time ?? null,
    buyerResponseDueAt: detail.buyer_response_due_date ?? summary.buyer_response_due_date ?? null,
    sellerResponseDueAt: detail.seller_response_due_date ?? summary.seller_response_due_date ?? null,
    timeline: disputeTimeline(detail),
  };
}

async function fetchDisputes(env: Env): Promise<NormalizedDispute[]> {
  // No window parameters. `start_time` is deprecated and is a 400 alongside
  // `disputed_transaction_id`; `update_time_after` already defaults to the full
  // 180 days PayPal will serve. Taking the lot every run is also what keeps a
  // six-month-old case that changed state today from being missed — keying this
  // off the transaction sync cursor would do exactly that.
  let url = `${base(env)}/v1/customer/disputes?page_size=${DISPUTE_PAGE_SIZE}`;
  const summaries: WireDisputeSummary[] = [];
  for (let page = 0; page < DISPUTE_MAX_PAGES && url; page++) {
    const body = await getJson<{ items?: WireDisputeSummary[]; links?: { href?: string; rel?: string }[] }>(
      env, url, '/v1/customer/disputes',
    );
    summaries.push(...(body.items ?? []));
    // `rel` first, href as the fallback: PayPal documents no `rel` enum for this
    // response, but from page 2 the *self* link also carries a
    // `next_page_token=`, so matching the token alone can pick the page just
    // fetched. The equality break is what makes that survivable either way —
    // without it the loop re-reads one page for all DISPUTE_MAX_PAGES rounds,
    // and since every summary costs a detail GET below, a stall is 1,000 PayPal
    // round trips and a case list silently truncated at the first page.
    const links = body.links ?? [];
    const next = links.find(l => l.rel === 'next' && l.href)?.href
      ?? links.find(l => l.href?.includes('next_page_token='))?.href
      ?? '';
    if (next === url) break;
    url = next;
  }

  const out: NormalizedDispute[] = [];
  for (const s of summaries) {
    if (!s.dispute_id) continue;
    const detail = await getJson<WireDisputeDetail>(
      env,
      `${base(env)}/v1/customer/disputes/${encodeURIComponent(s.dispute_id)}`,
      '/v1/customer/disputes/{id}',
    );
    out.push(normalizeDispute(s, detail));
  }
  return out;
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
    fetchDisputes: () => fetchDisputes(env),
  };
}
