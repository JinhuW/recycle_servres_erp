// Sync orchestration: fetch each configured provider since its cursor (minus
// an overlap window), upsert accounts + transactions, then auto-pair the
// PayPal/Mercury legs of the same payment and auto-link exact PayPal-txn-id
// matches to purchase orders. Everything per source runs in one transaction,
// so a crash mid-source leaves the previous cursor and a clean retry.

import type { Sql, TransactionSql } from 'postgres';
import { getDb } from '../db';
import { log } from '../lib/log';
import type { Env } from '../types';
import { pickBankProviders } from './index';
import { PAYPAL_ACH_DESCRIPTOR } from './mercury';
import type { BankProvider, BankSource, NormalizedDispute, NormalizedTxn } from './types';

const bankLog = log.child({ module: 'banktx' });

const OVERLAP_MS = 5 * 24 * 60 * 60 * 1000;
const BACKFILL_MS = 90 * 24 * 60 * 60 * 1000;
// A settlement can trail its PayPal charge by a weekend + holidays.
const PAIR_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type SyncCounts = {
  inserted: number;
  updated: number;
  paired: number;
  autoLinked: number;
  // Cases matched onto a transaction this run. `disputeError` is deliberately
  // not the per-source `error` below: that one means the transaction sync
  // failed, and folding a disputes 403 into it would report the money feed as
  // broken when it had just synced fine.
  disputes: number;
  disputeError?: string;
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
  settle_status: string;
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

// doSync swallows a provider's failure into its own slot so one bank being down
// can't block the other — which means the loop's catch never fires for the
// failure that actually matters. Without this the six-hourly pass is silent in
// both directions: nothing distinguishes twenty-four clean runs from
// twenty-four broken ones, and the only way to find out is to open Payments and
// press Sync now. Exported so a test can assert the lines.
export function reportSyncResult(result: SyncResult): void {
  for (const [source, counts] of Object.entries(result.perSource)) {
    if (!counts) continue;
    if (counts.error) bankLog.warn('sync failed for a source', { source, error: counts.error });
    else bankLog.info('sync pass', { source, ...counts });
  }
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
      reportSyncResult(await syncBankTransactions(env));
    } catch (err) {
      bankLog.error('sync pass failed', err);
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
        inserted: 0, updated: 0, paired: 0, autoLinked: 0, disputes: 0,
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
  // A row we are still holding as pending has to stay inside the window until
  // it resolves, however long that takes — otherwise its badge is frozen at
  // whatever it said the day it fell out. The overlap alone is not enough: a
  // PayPal payment can sit pending for weeks, and a Mercury pending row is
  // dated by creation because it has no posted date at all.
  const [oldest] = await sql<{ min: Date | null }[]>`
    SELECT MIN(posted_at) AS min FROM bank_transactions
    WHERE source = ${source} AND settle_status = 'pending'`;
  const sinceMs = Math.min(
    Number.isFinite(cursorMs) ? cursorMs - OVERLAP_MS : Date.now() - BACKFILL_MS,
    oldest?.min ? oldest.min.getTime() : Infinity,
  );
  const runStartIso = new Date().toISOString();

  const { accounts, txns } = await provider.fetchSince(new Date(sinceMs).toISOString());

  // Disputes are a second API behind a second app permission, so this failing
  // must leave the money feed alone. The message is *stored*, not merely
  // logged: nobody watches stdout for the six-hourly loop, and a dispute list
  // that is quietly always empty reads as good news.
  let disputes: NormalizedDispute[] = [];
  let disputeError: string | undefined;
  if (provider.fetchDisputes) {
    try {
      disputes = await provider.fetchDisputes();
    } catch (e) {
      disputeError = e instanceof Error ? e.message : 'dispute sync failed';
      log.warn('dispute sync failed', { module: 'banktx', source, error: disputeError });
    }
  }

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
          (source, external_id, account_id, posted_at, amount, counterparty, description, paypal_txn_id,
           category, settle_status, raw)
        VALUES
          (${source}, ${t.externalId}, ${accountId}, ${t.postedAt}, ${t.amount},
           ${t.counterparty}, ${t.description}, ${t.paypalTxnId}, ${t.category},
           ${t.settleStatus}, ${tx.json(t.raw as never)})
        ON CONFLICT (source, external_id) DO UPDATE SET
          posted_at = EXCLUDED.posted_at,
          amount = EXCLUDED.amount,
          counterparty = EXCLUDED.counterparty,
          description = EXCLUDED.description,
          paypal_txn_id = EXCLUDED.paypal_txn_id,
          -- Never a human's to override, and the only thing that clears a
          -- pending badge: a payment settles by being re-fetched, not by
          -- anyone acting on it here.
          settle_status = EXCLUDED.settle_status,
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
        AND bt.category = 'external' AND NOT bt.category_manual AND bt.order_id IS NULL
        -- Money that never moved is not a transfer; reclassifying it would put
        -- it back into a tile it is deliberately kept out of.
        AND bt.settle_status = 'settled'`;

    // Only PayPal rows carry a case. The Mercury settlement leg parses the same
    // paypal_txn_id out of its description, so without this filter a pair that
    // hasn't been grouped yet would be badged twice and counted twice.
    let disputeHits = 0;
    for (const d of disputes) {
      if (!d.disputeId || d.txnIds.length === 0) continue;
      const rows = await tx<{ id: string; dispute: NormalizedDispute[] | null }[]>`
        SELECT id, dispute FROM bank_transactions
        WHERE source = 'paypal' AND UPPER(paypal_txn_id) = ANY(${d.txnIds}::text[])`;
      // A case for a payment the feed hasn't reached yet matches nothing and
      // lands on the next pass — the window is 180 days, not a cursor.
      if (rows.length) disputeHits++;
      for (const r of rows) {
        // One payment can carry a PayPal claim *and* a card chargeback, so this
        // is a list keyed by case id, not a single value.
        const next = [...(r.dispute ?? []).filter(x => x.disputeId !== d.disputeId), d]
          .sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''));
        await tx`UPDATE bank_transactions SET dispute = ${tx.json(next as never)} WHERE id = ${r.id}`;
      }
    }
    if (provider.fetchDisputes) {
      await tx`UPDATE bank_accounts SET dispute_error = ${disputeError ?? null} WHERE source = ${source}`;
    }

    // A pair may now hold a leg that has not posted, and Mercury pulls do
    // fail — then retry under a new id. The pair has to let go of the failed
    // leg or the retry finds its PayPal charge already taken. Only pair_id is
    // cleared: no_auto_pair is a human's Ungroup, and setting it here would
    // stop the retry pairing on its own. Transfer pairs are left alone.
    const dissolved = await tx`
      UPDATE bank_transactions SET pair_id = NULL
      WHERE pair_id IN (SELECT pair_id FROM bank_transactions
                        WHERE pair_id IS NOT NULL AND settle_status = 'failed'
                          AND category = 'external')
      RETURNING id`;
    if (dissolved.count > 0) {
      bankLog.info('dissolved pairs with a failed leg', { source, rows: dissolved.count });
    }

    const paired = await autoPair(tx);
    const autoLinked = await autoLink(tx);
    return { inserted, updated, paired, autoLinked, disputes: disputeHits, disputeError };
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
           category, category_manual, order_id, link_kind, link_auto, linked_by, linked_at,
           settle_status
    FROM bank_transactions
    WHERE pair_id IS NULL AND NOT no_auto_pair AND NOT ignored
      -- Pairing is a claim that two legs are one payment. A pending leg is
      -- one: Mercury reports the pull days before it posts, and holding the
      -- pair back until then left one payment showing as two unlinked rows.
      -- A failed leg never moved money and a reversed one gave it back, so a
      -- match on either can only be a false positive.
      AND settle_status <> 'failed' AND settle_status <> 'reversed'
      -- A row someone owns, or filed under an internal transaction, is under
      -- human handling: restructuring it here would move an assigned payment's
      -- link onto it, or (via transferPair) re-categorize it out of the queue
      -- the assignment deliberately kept it in.
      AND assignee_id IS NULL AND internal_txn_id IS NULL`;

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

  // Transfers stay settled-only: the counterparty rule and mark-transfer both
  // refuse to reclassify a pending row, and pairing here would do it anyway.
  const transferPairs = await transferPair(tx, legs.filter((l) => l.settle_status === 'settled'), taken);
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
      -- A payment in flight still answers "what paid for this PO"; a denied or
      -- reversed one does not, and claiming it would leave the order reading
      -- as paid on money that never left, or came back.
      AND settle_status IN ('settled', 'pending')
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
      -- The link is the answer the owner tag was standing in for, so it
      -- replaces it — and must, or the CHECK in migrations/0116 aborts the
      -- transaction, which on the sync path means every run from then on.
      SET order_id = ${orderId}, link_kind = ${kind}, link_auto = ${actorId === null},
          linked_by = ${actorId}, linked_at = NOW(),
          assignee_id = NULL, assigned_by = NULL, assigned_at = NULL
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
      AND settle_status IN ('settled', 'pending')
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
