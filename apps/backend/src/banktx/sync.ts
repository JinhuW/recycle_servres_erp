// Sync orchestration: fetch each configured provider since its cursor (minus
// an overlap window), upsert accounts + transactions, then auto-pair the
// PayPal/Mercury legs of the same payment and auto-link exact PayPal-txn-id
// matches to purchase orders. Everything per source runs in one transaction,
// so a crash mid-source leaves the previous cursor and a clean retry.

import type { Sql, TransactionSql } from 'postgres';
import { getDb } from '../db';
import { allLimited } from '../lib/concurrency';
import { log } from '../lib/log';
import type { Env } from '../types';
import { applyIgnoreRules } from './ignoreRules';
import { pickBankProviders, type BankProviderPick } from './index';
import { PAIR_AUTO_WINDOW_DAYS } from './match';
import { PAYPAL_ACH_DESCRIPTOR } from './mercury';
import type { BankProvider, BankSource, NormalizedDispute, NormalizedTxn } from './types';

const bankLog = log.child({ module: 'banktx' });

const DAY_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * DAY_MS;
const BACKFILL_MS = 90 * DAY_MS;
// A row pending this long has been abandoned by its provider rather than
// delayed, and holding the window open for it costs every run a fetch that far
// back.
const PENDING_REACH_MS = 120 * DAY_MS;
// The cursor window only reaches OVERLAP_MS behind, so a settled row reversed
// weeks later would never be re-read. Once a week each account is fetched this
// far back instead.
const DEEP_WINDOW_MS = 60 * DAY_MS;
const DEEP_EVERY_MS = 7 * DAY_MS;
// A settlement can trail its PayPal charge by a weekend + holidays. Shared with
// the read-time pair suggestion so the two never disagree.
const PAIR_WINDOW_MS = PAIR_AUTO_WINDOW_DAYS * 24 * 60 * 60 * 1000;
// Rows per upsert statement: 11 parameters each, far below the protocol's
// 65535-parameter ceiling, and small enough to keep one statement's plan cheap.
const UPSERT_CHUNK = 500;

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
  ignored: boolean;
};

export type SyncOptions = {
  // false skips the dispute list. For a pull that only needs the money feed —
  // a purchaser waiting on Submit — the cases are a second API's worth of
  // latency answering nothing that was asked. Defaults to on.
  disputes?: boolean;
};

type Run = { sources: ReadonlySet<BankSource>; disputes: boolean; result: Promise<SyncResult> };

// Two concurrent "Sync now" clicks (or a click racing the interval) join the
// same run instead of double-fetching the providers. Only a run that covers
// the request may be joined: every source it asks for, and the disputes too if
// it wants them. A full sync that joined a PayPal-only pull would come back
// without Mercury and report success. Keyed by what a run covers, so at most
// one run per shape is in flight.
const inFlight = new Map<string, Run>();

export function syncBankTransactions(
  env: Env,
  providersOverride?: BankProvider[],
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const picked: BankProviderPick = providersOverride
    ? { providers: providersOverride, notConfigured: [] }
    : pickBankProviders(env);
  const disputes = opts.disputes !== false;
  const sources = new Set(picked.providers.map((p) => p.source));
  for (const run of inFlight.values()) {
    if ([...sources].every((s) => run.sources.has(s)) && (run.disputes || !disputes)) {
      // A wider run answers for sources this caller never asked about; it
      // gets back only its own.
      return run.result.then((r) => ({
        perSource: Object.fromEntries(Object.entries(r.perSource).filter(([s]) => sources.has(s as BankSource))),
        notConfigured: picked.notConfigured,
      }));
    }
  }
  const key = `${[...sources].sort().join(',')}|${disputes ? 'disputes' : 'no-disputes'}`;
  const result = doSync(env, picked, disputes).finally(() => inFlight.delete(key));
  inFlight.set(key, { sources, disputes, result });
  return result;
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

// Background freshness (same shape as startPackageTrackingLoop). Volumes are
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

async function doSync(env: Env, picked: BankProviderPick, disputes: boolean): Promise<SyncResult> {
  const sql = getDb(env);
  const result: SyncResult = { perSource: {}, notConfigured: picked.notConfigured };

  for (const provider of picked.providers) {
    try {
      result.perSource[provider.source] = await syncOne(sql, provider, disputes);
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

async function syncOne(
  sql: ReturnType<typeof getDb>,
  provider: BankProvider,
  withDisputes: boolean,
): Promise<SyncCounts> {
  const source = provider.source;
  // A row we are still holding as pending has to stay inside its account's
  // window until it resolves — otherwise its badge is frozen at whatever it
  // said the day it fell out. The overlap alone is not enough: a PayPal
  // payment can sit pending for weeks, and a Mercury pending row is dated by
  // creation because it has no posted date at all. Past PENDING_REACH_MS it is
  // let go: the oldest pending row inside that reach holds the window instead.
  //
  // An account appearing for the first time — the IO card, first listed by a
  // run after the one that rewound the cursors for it — reaches back as far as
  // anything the source is fetching or already holds (`oldestRow`), so a run
  // that failed to list it costs nothing but a retry.
  const nowMs = Date.now();
  const [known, [oldestRow]] = await allLimited([
    () => sql<{
      external_id: string; sync_cursor: string | null; oldest_pending: Date | null; deep_synced_at: Date | null;
    }[]>`
      SELECT a.external_id, a.sync_cursor, a.deep_synced_at,
             (SELECT MIN(t.posted_at) FROM bank_transactions t
              WHERE t.account_id = a.id AND t.settle_status = 'pending'
                AND t.posted_at >= ${new Date(nowMs - PENDING_REACH_MS)}) AS oldest_pending
      FROM bank_accounts a WHERE a.source = ${source}`,
    () => sql<{ min: Date | null }[]>`
      SELECT MIN(posted_at) AS min FROM bank_transactions WHERE source = ${source}`,
  ] as const);
  const backfillMs = nowMs - BACKFILL_MS;
  const deepMs = nowMs - DEEP_WINDOW_MS;
  const since = new Map(known.map((a) => [a.external_id, Math.min(
    a.sync_cursor ? new Date(a.sync_cursor).getTime() - OVERLAP_MS : backfillMs,
    a.oldest_pending ? a.oldest_pending.getTime() : Infinity,
    !a.deep_synced_at || a.deep_synced_at.getTime() < nowMs - DEEP_EVERY_MS ? deepMs : Infinity,
  )]));
  const sinceMs = since.size ? Math.min(...since.values()) : backfillMs;
  const newSinceMs = Math.min(sinceMs, backfillMs, oldestRow?.min ? oldestRow.min.getTime() : Infinity);
  const runStartIso = new Date(nowMs).toISOString();

  // Disputes are a second API behind a second app permission, so this failing
  // must leave the money feed alone. The message is *stored*, not merely
  // logged: nobody watches stdout for the six-hourly loop, and a dispute list
  // that is quietly always empty reads as good news. It never rejects, so it
  // can run alongside the transaction fetch.
  const disputesWanted = withDisputes && !!provider.fetchDisputes;
  let disputes: NormalizedDispute[] = [];
  let disputeError: string | undefined;
  const disputesDone = (async () => {
    if (!disputesWanted) return;
    try {
      disputes = await provider.fetchDisputes!(await storedDisputes(sql, source));
    } catch (e) {
      disputeError = e instanceof Error ? e.message : 'dispute sync failed';
      log.warn('dispute sync failed', { module: 'banktx', source, error: disputeError });
    }
  })();

  const [{ accounts, txns, partialErrors }] = await Promise.all([
    provider.fetchSince(new Date(sinceMs).toISOString(), {
      since: new Map([...since].map(([id, ms]) => [id, new Date(ms).toISOString()])),
      newSince: new Date(newSinceMs).toISOString(),
    }),
    disputesDone,
  ]);

  // Where each part that failed gets written. An account with a row of its own
  // carries its own error. A failure with no row to hold it — the /credit list,
  // or a card failing before it ever synced — is recorded on every account the
  // run did sync, the way dispute_error is source-wide, so /stats still shows
  // it; the next clean run clears it from all of them.
  const accountError = new Map<string, string>();
  const unhoused: string[] = [];
  for (const e of partialErrors ?? []) {
    if (e.account && since.has(e.account)) accountError.set(e.account, e.message);
    else unhoused.push(e.message);
  }
  const sourceError = unhoused.length ? unhoused.join('; ') : null;
  // Whether this run's window for an account reached the deep window. A
  // provider that fetches every account from `sinceIso` reached at least as
  // far as the account's own start, so this never stamps a shallow run.
  const deepIds = new Set(accounts
    .filter((a) => (since.get(a.externalId) ?? newSinceMs) <= deepMs)
    .map((a) => a.externalId));

  return sql.begin(async (tx) => {
    const accountIds = new Map<string, string>();
    for (const a of accounts) {
      const deep = deepIds.has(a.externalId);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO bank_accounts (source, external_id, name, last_synced_at, sync_cursor, sync_error, deep_synced_at)
        VALUES (${source}, ${a.externalId}, ${a.name}, NOW(), ${runStartIso}, ${sourceError},
                CASE WHEN ${deep}::boolean THEN NOW() END)
        ON CONFLICT (source, external_id) DO UPDATE
          SET name = EXCLUDED.name, last_synced_at = NOW(), sync_cursor = ${runStartIso},
              sync_error = EXCLUDED.sync_error,
              deep_synced_at = CASE WHEN ${deep}::boolean THEN NOW() ELSE bank_accounts.deep_synced_at END
        RETURNING id`;
      accountIds.set(a.externalId, row.id);
    }
    // A known account the provider could not read keeps its cursor and its
    // last sync time, so the next run retries the same window; it only learns
    // why.
    for (const [externalId, message] of accountError) {
      await tx`
        UPDATE bank_accounts SET sync_error = ${message}
        WHERE source = ${source} AND external_id = ${externalId}`;
    }

    // A row for an account the provider didn't list is skipped, uncounted.
    // A feed that repeats an id must be de-duplicated before a multi-row
    // upsert — Postgres refuses to touch one row twice in a statement
    // (SQLSTATE 21000). The last copy wins, as when each copy was its own
    // upsert, and each dropped copy still counts as the update it would
    // have been.
    const byExternalId = new Map<string, NormalizedTxn & { accountId: string }>();
    let updated = 0;
    for (const t of txns) {
      const accountId = accountIds.get(t.accountExternalId);
      if (!accountId) continue;
      if (byExternalId.delete(t.externalId)) updated++;
      byExternalId.set(t.externalId, { ...t, accountId });
    }
    const rows = [...byExternalId.values()].map((t) => ({
      source, external_id: t.externalId, account_id: t.accountId, posted_at: t.postedAt,
      amount: t.amount, counterparty: t.counterparty, description: t.description,
      paypal_txn_id: t.paypalTxnId, category: t.category, settle_status: t.settleStatus,
      raw: tx.json(t.raw as never),
    }));

    let inserted = 0;
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      // DO UPDATE touches only provider-owned fields — link/pair/ignore and
      // the tombstones are human state and must survive every re-sync.
      const fresh = await tx<{ fresh: boolean }[]>`
        INSERT INTO bank_transactions ${tx(
          // The helper's typing has no room for a json() parameter as a value.
          rows.slice(i, i + UPSERT_CHUNK) as never,
          'source', 'external_id', 'account_id', 'posted_at', 'amount', 'counterparty',
          'description', 'paypal_txn_id', 'category', 'settle_status', 'raw')}
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
      for (const r of fresh) {
        if (r.fresh) inserted++; else updated++;
      }
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
    // A run that skipped the cases knows nothing about them, and must not
    // clear an error a full run recorded.
    if (disputesWanted) {
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
    // Last, not before pairing: autoPair skips ignored rows, so a rule that
    // matched a PayPal charge first would strand its Mercury settlement leg
    // (which reads "PAYPAL …" and matches nothing) in the very queue the rule
    // exists to empty. After pairing, the rule takes both legs.
    const ruleIgnored = await applyIgnoreRules(tx);
    if (ruleIgnored > 0) bankLog.info('ignore rules applied', { source, rows: ruleIgnored });
    return { inserted, updated, paired, autoLinked, disputes: disputeHits, disputeError };
  });
}

// The cases already on file, by id, so the provider can skip re-reading the
// detail of one PayPal hasn't touched. A case sits on every row it matched;
// any copy will do, the newest is taken.
async function storedDisputes(
  sql: ReturnType<typeof getDb>,
  source: BankSource,
): Promise<Map<string, NormalizedDispute>> {
  const rows = await sql<{ d: NormalizedDispute }[]>`
    SELECT DISTINCT ON (d->>'disputeId') d
    FROM bank_transactions bt, jsonb_array_elements(bt.dispute) d
    WHERE bt.source = ${source} AND jsonb_typeof(bt.dispute) = 'array'
    ORDER BY d->>'disputeId', d->>'updatedAt' DESC NULLS LAST`;
  return new Map(rows.map((r) => [r.d.disputeId, r.d]));
}

// ─── Auto-pair ────────────────────────────────────────────────────────────────
// A logical payment shows up twice: the PayPal charge and the Mercury
// settlement. Candidates must agree on the signed amount; a reference match
// (Mercury description carries the PayPal txn id) pairs regardless of date,
// an amount+date match only when it is unambiguous on both sides.

// A note lives on every leg of a pair (0120) so the feed, which renders one
// leg, always sees it. /pair copies a lone note across when a human groups
// two rows; the same has to happen here or a note left on the Mercury
// settlement before its PayPal charge arrived vanishes behind the display
// leg. Two different notes are both kept — nothing here can ask which wins.
async function copyNoteAcrossPair(tx: Tx, pairId: string): Promise<void> {
  await tx`
    UPDATE bank_transactions t
    SET note = s.note, note_by = s.note_by, note_at = s.note_at
    FROM bank_transactions s
    WHERE t.pair_id = ${pairId} AND t.note IS NULL
      AND s.pair_id = ${pairId} AND s.note IS NOT NULL`;
}

async function autoPair(tx: Tx): Promise<number> {
  const legs = await tx<LegRow[]>`
    SELECT id, source, external_id, amount::text AS amount, posted_at, paypal_txn_id, description,
           category, category_manual, order_id, link_kind, link_auto, linked_by, linked_at,
           settle_status, ignored
    FROM bank_transactions
    -- A human's Ignore is a verdict on the row and takes it out of pairing. A
    -- rule's is not: the PayPal charge a rule dismissed still has a Mercury
    -- settlement on its way, and if the two don't pair the settlement leg sits
    -- in the queue reading "PAYPAL …", which no rule matches. Paired, the rule
    -- pass takes it along with its sibling.
    WHERE pair_id IS NULL AND NOT no_auto_pair AND (NOT ignored OR ignore_rule_id IS NOT NULL)
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
    // Spreading a link onto a rule-ignored leg would make a row that is both
    // linked and ignored — the state /ignore and /link each refuse to create.
    if (linked.length === 1 && (m.ignored || p.ignored)) continue;
    const pairId = crypto.randomUUID();
    await tx`UPDATE bank_transactions SET pair_id = ${pairId} WHERE id IN (${m.id}, ${p.id})`;
    await copyNoteAcrossPair(tx, pairId);
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
  // Ignored legs were let in only for payment pairing above.
  const transferPairs = await transferPair(tx, legs.filter((l) => l.settle_status === 'settled' && !l.ignored), taken);
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
    await copyNoteAcrossPair(tx, pairId);
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
//
// And only onto an order the company paid for through PayPal. A self-paid or
// cash PO holding a leftover id would book a company payment against an
// order the company never paid; an archived one is history; and an id two
// live POs both carry says nothing about which of them it paid for. NULL
// method is a scan-born Draft nobody has asked yet — still a company card.
export async function linkPaypalTxnToOrder(
  tx: Sql | TransactionSql,
  paypalTxnId: string,
  orderId: string,
  actorId: string | null,
): Promise<number> {
  const eligible = await tx`
    SELECT 1 FROM orders o
    WHERE o.id = ${orderId} AND o.payment = 'company'
      AND o.payment_method IS DISTINCT FROM 'cash' AND o.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM orders other
        WHERE other.id <> o.id AND other.archived_at IS NULL
          AND UPPER(other.paypal_txn_id) = UPPER(${paypalTxnId}))`;
  if (eligible.length === 0) return 0;

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

// The other half of a typed id: when a PO's id changes or is cleared, the
// payments it claimed through the old one let go — pair siblings with them,
// since a pair is one payment. No `no_auto_link` tombstone: nothing about the
// payment was judged wrong, and the next order to carry the id should get it.
// A link a manager made stays: their /link is a decision about the payment,
// and a purchaser re-typing the field must not quietly undo it.
export async function unlinkPaypalTxnFromOrder(
  tx: Sql | TransactionSql,
  orderId: string,
  oldTxnId: string,
): Promise<number> {
  const freed = await tx`
    WITH hit AS (
      SELECT bt.id, bt.pair_id FROM bank_transactions bt
      WHERE bt.order_id = ${orderId} AND UPPER(bt.paypal_txn_id) = UPPER(${oldTxnId})
        AND NOT EXISTS (SELECT 1 FROM users m WHERE m.id = bt.linked_by AND m.role = 'manager')
    )
    UPDATE bank_transactions t
    SET order_id = NULL, link_kind = NULL, link_auto = FALSE, linked_by = NULL, linked_at = NULL
    WHERE t.order_id = ${orderId}
      AND (t.id IN (SELECT id FROM hit)
           OR t.pair_id IN (SELECT pair_id FROM hit WHERE pair_id IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM users m WHERE m.id = t.linked_by AND m.role = 'manager')
    RETURNING t.id`;
  return freed.count;
}

async function autoLink(tx: Tx): Promise<number> {
  const groups = await tx<{ ptxn: string }[]>`
    SELECT MAX(paypal_txn_id) AS ptxn
    FROM bank_transactions
    WHERE order_id IS NULL AND NOT no_auto_link AND NOT ignored
      AND paypal_txn_id IS NOT NULL AND category <> 'transfer'
      AND settle_status IN ('settled', 'pending')
    GROUP BY COALESCE(pair_id, id)`;

  if (groups.length === 0) return 0;
  // Only an id exactly one PO carries is unambiguous. Compared as stored, not
  // uppercased: an id carrying lowercase matches no uppercased PO id, and so
  // is never auto-linked. An archived PO neither claims nor contests one.
  const owners = await tx<{ ptxn: string; id: string }[]>`
    SELECT UPPER(paypal_txn_id) AS ptxn, MIN(id) AS id
    FROM orders
    WHERE UPPER(paypal_txn_id) = ANY(${groups.map((g) => g.ptxn)}::text[])
      AND archived_at IS NULL
    GROUP BY UPPER(paypal_txn_id)
    HAVING COUNT(*) = 1`;
  const ownerOf = new Map(owners.map((o) => [o.ptxn, o.id]));

  let linked = 0;
  for (const g of groups) {
    const orderId = ownerOf.get(g.ptxn);
    if (orderId === undefined) continue;
    linked += await linkPaypalTxnToOrder(tx, g.ptxn, orderId, null);
  }
  return linked;
}
