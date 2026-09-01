// Sync orchestration: fetch each configured provider since its cursor (minus
// an overlap window), upsert accounts + transactions, then auto-pair the
// PayPal/Mercury legs of the same payment and auto-link exact PayPal-txn-id
// matches to purchase orders. Everything per source runs in one transaction,
// so a crash mid-source leaves the previous cursor and a clean retry.

import type { Sql, TransactionSql } from 'postgres';
import { getDb } from '../db';
import type { Env } from '../types';
import { pickBankProviders } from './index';
import { PAYPAL_ACH_DESCRIPTOR } from './mercury';
import type { BankProvider, BankSource, NormalizedTxn } from './types';

const OVERLAP_MS = 5 * 24 * 60 * 60 * 1000;
const BACKFILL_MS = 90 * 24 * 60 * 60 * 1000;
// A settlement can trail its PayPal charge by a weekend + holidays.
const PAIR_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type SyncCounts = {
  inserted: number;
  updated: number;
  paired: number;
  autoLinked: number;
};

export type SyncResult = {
  perSource: Partial<Record<BankSource, SyncCounts & { error?: string }>>;
  notConfigured: BankSource[];
};

type Tx = TransactionSql;

type LegRow = {
  id: string;
  source: BankSource;
  external_id: string;
  amount: string;
  posted_at: Date;
  paypal_txn_id: string | null;
  description: string | null;
  category: string;
  category_manual: boolean;
  order_id: string | null;
  link_kind: string | null;
  link_auto: boolean;
  linked_by: string | null;
  linked_at: Date | null;
};

// Two concurrent "Sync now" clicks (or a click racing the interval) join the
// same run instead of double-fetching the providers.
let inFlight: Promise<SyncResult> | null = null;

export function syncBankTransactions(env: Env, providersOverride?: BankProvider[]): Promise<SyncResult> {
  if (inFlight) return inFlight;
  const run = doSync(env, providersOverride).finally(() => { inFlight = null; });
  inFlight = run;
  return run;
}

// Background freshness (same shape as startShipmentTrackingLoop). Volumes are
// tiny and the page has a Sync-now button, so a slow cadence is plenty. Never
// starts when nothing is configured.
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startBankSyncLoop(env: Env): { stop: () => void } {
  if (pickBankProviders(env).providers.length === 0) return { stop: () => {} };
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await syncBankTransactions(env);
    } catch (err) {
      console.warn('[banktx] sync pass failed', err);
    }
  };
  void tick();
  const handle = setInterval(tick, SYNC_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

async function doSync(env: Env, providersOverride?: BankProvider[]): Promise<SyncResult> {
  const picked = providersOverride
    ? { providers: providersOverride, notConfigured: [] as BankSource[] }
    : pickBankProviders(env);
  const sql = getDb(env);
  const result: SyncResult = { perSource: {}, notConfigured: picked.notConfigured };

  for (const provider of picked.providers) {
    try {
      result.perSource[provider.source] = await syncOne(sql, provider);
    } catch (e) {
      // One provider down must not block the other; the page shows the error.
      result.perSource[provider.source] = {
        inserted: 0, updated: 0, paired: 0, autoLinked: 0,
        error: e instanceof Error ? e.message : 'sync failed',
      };
    }
  }
  return result;
}

async function syncOne(sql: ReturnType<typeof getDb>, provider: BankProvider): Promise<SyncCounts> {
  const source = provider.source;
  const cursors = await sql<{ min: string | null }[]>`
    SELECT MIN(sync_cursor) AS min FROM bank_accounts WHERE source = ${source}`;
  const cursorMs = cursors[0]?.min ? new Date(cursors[0].min).getTime() : NaN;
  const sinceMs = Number.isFinite(cursorMs) ? cursorMs - OVERLAP_MS : Date.now() - BACKFILL_MS;
  const runStartIso = new Date().toISOString();

  const { accounts, txns } = await provider.fetchSince(new Date(sinceMs).toISOString());

  return sql.begin(async (tx) => {
    const accountIds = new Map<string, string>();
    for (const a of accounts) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO bank_accounts (source, external_id, name, last_synced_at, sync_cursor)
        VALUES (${source}, ${a.externalId}, ${a.name}, NOW(), ${runStartIso})
        ON CONFLICT (source, external_id) DO UPDATE
          SET name = EXCLUDED.name, last_synced_at = NOW(), sync_cursor = ${runStartIso}
        RETURNING id`;
      accountIds.set(a.externalId, row.id);
    }

    let inserted = 0;
    let updated = 0;
    for (const t of txns) {
      const accountId = accountIds.get(t.accountExternalId);
      if (!accountId) continue;
      // DO UPDATE touches only provider-owned fields — link/pair/ignore and
      // the tombstones are human state and must survive every re-sync.
      const [row] = await tx<{ fresh: boolean }[]>`
        INSERT INTO bank_transactions
          (source, external_id, account_id, posted_at, amount, counterparty, description, paypal_txn_id, category, raw)
        VALUES
          (${source}, ${t.externalId}, ${accountId}, ${t.postedAt}, ${t.amount},
           ${t.counterparty}, ${t.description}, ${t.paypalTxnId}, ${t.category}, ${tx.json(t.raw as never)})
        ON CONFLICT (source, external_id) DO UPDATE SET
          posted_at = EXCLUDED.posted_at,
          amount = EXCLUDED.amount,
          counterparty = EXCLUDED.counterparty,
          description = EXCLUDED.description,
          paypal_txn_id = EXCLUDED.paypal_txn_id,
          -- A human verdict wins, and so does a link: re-classifying a row
          -- someone tied to an order would drop it out of payment pairing
          -- behind their back (the state mark-transfer refuses to create).
          category = CASE WHEN bank_transactions.category_manual OR bank_transactions.order_id IS NOT NULL
                          THEN bank_transactions.category ELSE EXCLUDED.category END,
          raw = EXCLUDED.raw
        RETURNING (xmax = 0) AS fresh`;
      if (row.fresh) inserted++; else updated++;
    }

    // Counterparty-taught transfers: re-applied after every upsert, because
    // the upsert resets non-manual categories to what the provider said.
    await tx`
      UPDATE bank_transactions bt SET category = 'transfer'
      FROM bank_transfer_counterparties r
      WHERE bt.source = r.source AND bt.counterparty = r.counterparty
        AND bt.category = 'external' AND NOT bt.category_manual AND bt.order_id IS NULL`;

    const paired = await autoPair(tx);
    const autoLinked = await autoLink(tx);
    return { inserted, updated, paired, autoLinked };
  });
}

// ─── Auto-pair ────────────────────────────────────────────────────────────────
// A logical payment shows up twice: the PayPal charge and the Mercury
// settlement. Candidates must agree on the signed amount; a reference match
// (Mercury description carries the PayPal txn id) pairs regardless of date,
// an amount+date match only when it is unambiguous on both sides.

async function autoPair(tx: Tx): Promise<number> {
  const legs = await tx<LegRow[]>`
    SELECT id, source, external_id, amount::text AS amount, posted_at, paypal_txn_id, description,
           category, category_manual, order_id, link_kind, link_auto, linked_by, linked_at
    FROM bank_transactions
    WHERE pair_id IS NULL AND NOT no_auto_pair AND NOT ignored`;

  // Payment pairing is external-only: a transfer leg's sibling has the
  // OPPOSITE sign (money leaving Mercury lands in PayPal), so it would only
  // ever false-positive here — transferPair below handles it.
  const external = legs.filter((l) => l.category !== 'transfer');
  const mercury = external.filter((l) => l.source === 'mercury');
  const paypalById = new Map(external.filter((l) => l.source === 'paypal').map((l) => [l.external_id, l]));
  const taken = new Set<string>();
  const pairs: Array<[LegRow, LegRow]> = [];

  for (const m of mercury) {
    if (!m.paypal_txn_id) continue;
    const p = paypalById.get(m.paypal_txn_id);
    if (p && !taken.has(p.id) && Number(p.amount) === Number(m.amount)) {
      pairs.push([m, p]);
      taken.add(m.id);
      taken.add(p.id);
    }
  }

  // Amount+date: bucket the leftovers by amount; only a 1:1 bucket within the
  // window is safe to pair — anything else waits for a human.
  const byAmount = new Map<string, { m: LegRow[]; p: LegRow[] }>();
  for (const l of external) {
    if (taken.has(l.id)) continue;
    const key = Number(l.amount).toFixed(2);
    const bucket = byAmount.get(key) ?? { m: [], p: [] };
    (l.source === 'mercury' ? bucket.m : bucket.p).push(l);
    byAmount.set(key, bucket);
  }
  for (const { m, p } of byAmount.values()) {
    if (m.length !== 1 || p.length !== 1) continue;
    const dt = Math.abs(m[0].posted_at.getTime() - p[0].posted_at.getTime());
    if (dt > PAIR_WINDOW_MS) continue;
    pairs.push([m[0], p[0]]);
    // Claim both legs, or transferPair re-examines them and can steal one into
    // a transfer pair — overwriting this pair_id and orphaning the sibling.
    taken.add(m[0].id);
    taken.add(p[0].id);
  }

  for (const [m, p] of pairs) {
    // A leg already linked to an order shares that link with its new sibling;
    // conflicting links mean the match is wrong — leave it to a human.
    const linked = [m, p].filter((l) => l.order_id);
    if (linked.length === 2 && m.order_id !== p.order_id) continue;
    const pairId = crypto.randomUUID();
    await tx`UPDATE bank_transactions SET pair_id = ${pairId} WHERE id IN (${m.id}, ${p.id})`;
    if (linked.length === 1) {
      const src = linked[0];
      await tx`
        UPDATE bank_transactions
        SET order_id = ${src.order_id}, link_kind = ${src.link_kind}, link_auto = ${src.link_auto},
            linked_by = ${src.linked_by}, linked_at = ${src.linked_at}
        WHERE pair_id = ${pairId} AND order_id IS NULL`;
    }
  }

  const transferPairs = await transferPair(tx, legs, taken);
  return pairs.length + transferPairs;
}

// A PayPal transfer leg (classified by event code) and its Mercury sibling
// carry opposite signs. Only an unambiguous 1:1 absolute-amount match within
// the window pairs; the Mercury side is then a transfer too — unless a human
// already ruled otherwise.
async function transferPair(tx: Tx, legs: LegRow[], taken: Set<string>): Promise<number> {
  const byAbs = new Map<string, { m: LegRow[]; p: LegRow[] }>();
  for (const l of legs) {
    if (taken.has(l.id) || l.order_id) continue;
    // PayPal candidates must already be transfers (event code). A Mercury
    // candidate is either still external, or a transfer *because of the
    // PayPal ACH descriptor* — which says its sibling is on PayPal, which is
    // precisely this pairing. A Mercury leg that is a transfer for any other
    // reason (kind, counterparty rule) has its sibling elsewhere: the other
    // Mercury account, or the sibling company.
    const eligible = l.source === 'paypal'
      ? l.category === 'transfer'
      : l.category === 'external' || (!!l.description && PAYPAL_ACH_DESCRIPTOR.test(l.description));
    if (!eligible) continue;
    const key = Math.abs(Number(l.amount)).toFixed(2);
    const bucket = byAbs.get(key) ?? { m: [], p: [] };
    (l.source === 'mercury' ? bucket.m : bucket.p).push(l);
    byAbs.set(key, bucket);
  }

  let paired = 0;
  for (const { m, p } of byAbs.values()) {
    if (m.length !== 1 || p.length !== 1) continue;
    if (Number(m[0].amount) !== -Number(p[0].amount)) continue;
    const dt = Math.abs(m[0].posted_at.getTime() - p[0].posted_at.getTime());
    if (dt > PAIR_WINDOW_MS) continue;
    const pairId = crypto.randomUUID();
    await tx`UPDATE bank_transactions SET pair_id = ${pairId} WHERE id IN (${m[0].id}, ${p[0].id})`;
    await tx`
      UPDATE bank_transactions SET category = 'transfer'
      WHERE id = ${m[0].id} AND NOT category_manual`;
    taken.add(m[0].id);
    taken.add(p[0].id);
    paired++;
  }
  return paired;
}

// ─── Auto-link ────────────────────────────────────────────────────────────────
// The PO already knows its PayPal txn id (screenshot OCR). An exact,
// unambiguous match links the whole logical payment; amount/date proximity is
// deliberately never persisted — those are read-time suggestions only.

// The one place a PayPal txn id becomes a persisted link. Shared with the
// order routes, which call it the moment a human types the id rather than
// leaving the match to a pass that runs every six hours; two copies of this
// rule would drift the instant either side grew a condition.
//
// `actorId` distinguishes the callers: a human typing the id is not an
// automatic guess, and the Payments page badges the difference.
//
// Only free transactions are claimed. `no_auto_link` is a manager's Unlink,
// `ignored` is their dismissal, and a row already carrying an order_id is
// someone else's decision — none of the three is a typed id's to overturn.
export async function linkPaypalTxnToOrder(
  tx: Sql | TransactionSql,
  paypalTxnId: string,
  orderId: string,
  actorId: string | null,
): Promise<number> {
  const groups = await tx<{ ids: string[]; amount: string }[]>`
    SELECT ARRAY_AGG(id::text) AS ids, MAX(amount::text) AS amount
    FROM bank_transactions bt
    WHERE order_id IS NULL AND NOT no_auto_link AND NOT ignored
      AND category <> 'transfer'
      AND UPPER(paypal_txn_id) = UPPER(${paypalTxnId})
      -- A pair is one payment in two legs. Linking the free leg of a pair
      -- whose other leg already belongs to another PO would split it across
      -- two orders — the state POST /:id/pair refuses outright.
      AND NOT EXISTS (
        SELECT 1 FROM bank_transactions sib
        WHERE bt.pair_id IS NOT NULL AND sib.pair_id = bt.pair_id
          AND sib.order_id IS NOT NULL)
    GROUP BY COALESCE(pair_id, id)`;

  for (const g of groups) {
    const kind = Number(g.amount) < 0 ? 'payment' : 'refund';
    await tx`
      UPDATE bank_transactions
      SET order_id = ${orderId}, link_kind = ${kind}, link_auto = ${actorId === null},
          linked_by = ${actorId}, linked_at = NOW()
      WHERE id IN ${tx(g.ids)}`;
  }
  return groups.length;
}

async function autoLink(tx: Tx): Promise<number> {
  const groups = await tx<{ ptxn: string }[]>`
    SELECT MAX(paypal_txn_id) AS ptxn
    FROM bank_transactions
    WHERE order_id IS NULL AND NOT no_auto_link AND NOT ignored
      AND paypal_txn_id IS NOT NULL AND category <> 'transfer'
    GROUP BY COALESCE(pair_id, id)`;

  let linked = 0;
  for (const g of groups) {
    const orders = await tx<{ id: string }[]>`
      SELECT id FROM orders WHERE UPPER(paypal_txn_id) = ${g.ptxn} LIMIT 2`;
    if (orders.length !== 1) continue;
    linked += await linkPaypalTxnToOrder(tx, g.ptxn, orders[0].id, null);
  }
  return linked;
}
