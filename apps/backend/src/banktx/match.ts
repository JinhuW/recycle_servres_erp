// Read-time matching of a bank transaction against purchase orders, by amount
// and date proximity. Deliberately never persisted (see autoLink in sync.ts):
// a proximity guess that gets written becomes indistinguishable from a human
// decision, and unlinking one leaves a no_auto_link tombstone behind.
//
// SQL narrows the pool, TypeScript ranks it. The pool is capped per
// transaction, so scoring in TS keeps the rules readable and unit-testable
// without a database — and one ORDER BY doesn't have to encode all of them.

import { getDb } from '../db';

type SqlClient = ReturnType<typeof getDb>;

// Candidates outside this window are not offered at all; inside it, the day
// gap only ranks. STRONG is the window a payment is normally entered within,
// and is what separates a confident match from a plausible one.
//
// The pool window is wide on purpose: routes/packages.ts mints a draft PO when
// a box is *delivered*, so for those the distance from the payment is the
// shipment's transit time. A narrow pool doesn't rank those low, it hides them.
export const MATCH_WINDOW_DAYS = 90;
export const STRONG_WINDOW_DAYS = 7;

// Cents of drift (rounding, an FX cent) should still match; a restocking fee
// or a different PO should not. The floor keeps small POs matchable at all;
// the ceiling stops a $40k lot from swallowing every neighbouring order.
const TOL_PCT = 0.01;
const TOL_MIN = 1;
const TOL_MAX = 20;

const EXACT_EPSILON = 0.005;

// Same cap on both paths, so the row badge's count and the expanded list agree.
const CANDIDATE_CAP = 25;

// The TS mirror of tolFrag below. Both exist because the feed's filter has no
// TypeScript leg to compute against; banktx-match.test.ts asserts they agree,
// so changing one and not the other fails rather than silently ships.
export function nearTolerance(amount: number): number {
  return Math.min(TOL_MAX, Math.max(TOL_MIN, Math.abs(amount) * TOL_PCT));
}

export type MatchLeg = {
  id: string;
  amount: number;
  posted_at: Date;
  counterparty: string | null;
  paypal_txn_id: string | null;
};

export type CandidateRow = {
  id: string;
  total_cost: number | null;
  created_at: Date;
  lifecycle: string;
  created_by_name: string | null;
  linked_total: number;
  seller_name: string | null;
  txn_hit: boolean;
  affinity: boolean;
  pool_total: number;
};

export type MatchReason = 'txn' | 'exact' | 'near' | 'search';
export type MatchConfidence = 'high' | 'medium' | 'low';

export type RankedCandidate = {
  id: string;
  totalCost: number | null;
  createdAt: Date;
  lifecycle: string;
  createdByName: string | null;
  reason: MatchReason;
  dayGap: number | null;
  amountDiff: number | null;
  confidence: MatchConfidence;
  linkedTotal: number;
  sellerName: string | null;
  affinity: boolean;
  covered: boolean;
};

// `total` is the whole pool, `shown` what survived the cap. They differ often
// enough that reporting only the capped number reads as "these are all of
// them" when 35 more were never offered.
export type CandidatePool = { ranked: RankedCandidate[]; total: number };

export type MatchSummary = {
  count: number;
  shown: number;
  confidence: MatchConfidence;
  best: {
    id: string;
    totalCost: number | null;
    createdAt: Date;
    dayGap: number | null;
    createdByName: string | null;
  };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOW_INTERVAL = `${MATCH_WINDOW_DAYS} days`;

// Floor, not round: a rounded gap puts "same day" next to two different dates,
// and makes the strong window 7.5 days wide.
function dayGapOf(createdAt: Date, postedAt: Date): number {
  return Math.floor(Math.abs(createdAt.getTime() - postedAt.getTime()) / MS_PER_DAY);
}

export function tolFrag(sql: SqlClient, legAlias: string) {
  const a = sql(legAlias);
  return sql`LEAST(${TOL_MAX}, GREATEST(${TOL_MIN}, ABS(${a}.amount) * ${TOL_PCT}))`;
}

// Same-ish amount, near-ish in time. Drafts stay in — a payment very often
// belongs to a PO that was only half entered.
//
// Two things this shape is load-bearing for:
//   * The column is bare on the left of a BETWEEN, never wrapped in ABS(), so
//     Postgres can turn it into a range and use the (total_cost, created_at)
//     index. ABS(o.total_cost - amount) <= tol means the same thing and costs
//     a full scan of `orders` per leg.
//   * total_cost is the GOODS total (services/orderGoodsTotal.ts derives it
//     from the lines); other_fees — PayPal fees, freight, a bought label —
//     is a separate column the bank very much did charge. Matching only the
//     goods total misses every PO with a fee bigger than TOL_MAX, i.e. most.
function amountDateFrag(sql: SqlClient, legAlias: string, orderAlias = 'o') {
  const a = sql(legAlias);
  const o = sql(orderAlias);
  const tol = tolFrag(sql, legAlias);
  return sql`
    ${o}.created_at BETWEEN ${a}.posted_at - ${WINDOW_INTERVAL}::interval
                        AND ${a}.posted_at + ${WINDOW_INTERVAL}::interval
    AND (
      ${o}.total_cost BETWEEN ABS(${a}.amount) - ${tol} AND ABS(${a}.amount) + ${tol}
      OR ${o}.total_cost + ${o}.other_fees
           BETWEEN ABS(${a}.amount) - ${tol} AND ABS(${a}.amount) + ${tol}
    )`;
}

// The PayPal txn id is an exact identifier, so it qualifies a PO on its own —
// the amount legitimately differs when the payment covered fees the PO's goods
// total doesn't. `packages` is included because that is where the OCR'd id
// lands first, and often the only place it ever lands.
function txnHitFrag(sql: SqlClient, legAlias: string, orderAlias = 'o') {
  const a = sql(legAlias);
  const o = sql(orderAlias);
  return sql`
    COALESCE(${a}.paypal_txn_id, '') <> '' AND (
      UPPER(${o}.paypal_txn_id) = UPPER(${a}.paypal_txn_id)
      OR EXISTS (SELECT 1 FROM packages p2
                 WHERE p2.order_id = ${o}.id
                   AND UPPER(p2.paypal_txn_id) = UPPER(${a}.paypal_txn_id)))`;
}

// Bank descriptors are not seller names: 'PAYPAL *JOHNSSERV' against a
// hand-typed "John's Servers". Compare the letters-and-digits of each and
// accept containment either way. The length floor keeps a two-character name
// from matching every descriptor there is.
function compressedFrag(sql: SqlClient, expr: ReturnType<SqlClient>) {
  return sql`regexp_replace(upper(${expr}), '[^A-Z0-9]', '', 'g')`;
}

function sellerNameFrag(sql: SqlClient, legAlias: string, orderAlias = 'o') {
  const a = sql(legAlias);
  const o = sql(orderAlias);
  const cp = compressedFrag(sql, sql`${a}.counterparty`);
  const seller = compressedFrag(sql, sql`p.seller_name`);
  return sql`(
    SELECT p.seller_name FROM packages p
    WHERE p.order_id = ${o}.id AND p.seller_name IS NOT NULL
      AND length(${cp}) >= 4 AND length(${seller}) >= 4
      AND (strpos(${cp}, ${seller}) > 0 OR strpos(${seller}, ${cp}) > 0)
    LIMIT 1
  )`;
}

// A row the manager can still act on. Defined once so the status filter, the
// `hasMatch` toggle, the stats tile and the rows that get a `match` payload
// cannot drift apart — they did, and the toggle then returned linked rows
// carrying no match at all.
export function openRowFrag(sql: SqlClient, legAlias: string) {
  const a = sql(legAlias);
  return sql`${a}.order_id IS NULL AND NOT ${a}.ignored AND ${a}.category = 'external'
    -- A denied or reversed payment is a record, not a task: there is nothing
    -- to reconcile it against. Pending stays in — that money is still moving,
    -- and it is exactly what the queue exists to chase.
    AND ${a}.settle_status <> 'failed' AND ${a}.settle_status <> 'reversed'`;
}

// What a logical payment's settlement state is, read from its feed row (the
// PayPal leg, or a lone row). Dead-first: a reversed charge reads reversed
// whatever its pull is doing, and stays out of the PO's paid total; otherwise
// the group is pending until its last leg posts. The filter and the row's
// badge both use this, so they cannot disagree about which rows are pending.
export function groupSettleFrag(sql: SqlClient, legAlias: string) {
  const a = sql(legAlias);
  return sql`CASE
    WHEN ${a}.settle_status IN ('failed', 'reversed') THEN ${a}.settle_status
    WHEN EXISTS (SELECT 1 FROM bank_transactions l
                 WHERE l.pair_id = ${a}.pair_id AND l.settle_status = 'pending') THEN 'pending'
    ELSE ${a}.settle_status END`;
}

// For the list filter and the stats tile, where only "does this row have any
// candidate at all" matters. Sits in the feed query's own WHERE so keyset
// pagination over the filtered set stays honest.
//
// Two EXISTS rather than one with an OR inside: a single OR spanning the
// amount range and the txn-id lookup can use neither index, and this predicate
// runs once per open transaction on the Payments mount and after every
// mutation.
export function hasMatchFrag(sql: SqlClient, legAlias: string) {
  return sql`(
    EXISTS (SELECT 1 FROM orders o
            WHERE o.archived_at IS NULL AND ${amountDateFrag(sql, legAlias)})
    OR EXISTS (SELECT 1 FROM orders o
               WHERE o.archived_at IS NULL AND ${txnHitFrag(sql, legAlias)})
  )`;
}

// ─── Manual grouping ─────────────────────────────────────────────────────────
// Which two legs may be joined into one logical payment. The rules mirror
// POST /:id/pair exactly, so a picker built on them can never offer something
// the endpoint then rejects.
//
// The leg side's own `pair_id IS NULL` is the caller's to guarantee: the batch
// below feeds legs in as a record set, which has no such column.
//
// The order_id clause is NULL-safe on purpose. The endpoint refuses only two
// legs linked to *different* orders, and propagates a lone link across the new
// pair; a bare `c.order_id = l.order_id` is never true for an unlinked leg and
// would hide the commonest manual case — link the PayPal leg to a PO, then
// group the Mercury one onto it.
export function pairEligibleFrag(sql: SqlClient, legAlias: string, candAlias: string) {
  const l = sql(legAlias);
  const c = sql(candAlias);
  return sql`
    ${c}.pair_id IS NULL
    AND NOT ${c}.ignored
    AND ${c}.category = 'external'
    -- Same rule autoPair follows: a pending leg is a real half — Mercury
    -- reports the pull before it posts — but a failed or reversed one is a
    -- record of money that never moved, or came back. Offering one here would
    -- make the picker propose the very match the endpoint refuses.
    AND ${c}.settle_status <> 'failed' AND ${c}.settle_status <> 'reversed'
    AND ${c}.source <> ${l}.source
    AND ${c}.amount = ${l}.amount
    AND (${c}.order_id IS NULL OR ${l}.order_id IS NULL OR ${c}.order_id = ${l}.order_id)`;
}

// The suggestion mirrors autoPair's window because it is the same claim made
// at read time; the picker is wider because a human is doing the choosing.
export const PAIR_AUTO_WINDOW_DAYS = 3;
export const PAIR_PICK_WINDOW_DAYS = 30;

export type PairLeg = {
  id: string;
  source: string;
  amount: number;
  posted_at: Date;
  order_id: string | null;
};

export type PairCandidate = {
  id: string;
  source: string;
  externalId: string;
  postedAt: Date;
  amount: number;
  counterparty: string | null;
  description: string | null;
  paypalTxnId: string | null;
  orderId: string | null;
  dayGap: number;
  // How many legs this candidate is itself eligible for. The one-click
  // suggestion needs 1: autoPair's safety test is two-sided (sync.ts), and a
  // one-sided one would point two rows confidently at the same counterpart,
  // where the second click 400s.
  reverseCount: number;
};

type PairRow = {
  leg_id: string;
  id: string;
  source: string;
  external_id: string;
  posted_at: Date;
  amount: number;
  counterparty: string | null;
  description: string | null;
  paypal_txn_id: string | null;
  order_id: string | null;
  reverse_count: number;
};

// One round trip for a page of legs, same shape as fetchCandidatesBatch.
// `skipTombstoned` is what separates the two callers: the read-time suggestion
// is the automatic matcher speaking, so it must honour a human's Ungroup
// (no_auto_pair) or it re-proposes the grouping they just undid on every
// refetch. The picker is the human speaking, and 0100's comment is explicit
// that the tombstones gate "auto" only.
export async function pairCandidatesBatch(
  sql: SqlClient,
  legs: PairLeg[],
  opts: { windowDays: number; limit: number; skipTombstoned: boolean },
): Promise<Map<string, PairCandidate[]>> {
  const out = new Map<string, PairCandidate[]>();
  if (legs.length === 0) return out;

  const win = `${opts.windowDays} days`;
  const liveFrag = (alias: string) =>
    opts.skipTombstoned ? sql`NOT ${sql(alias)}.no_auto_pair` : sql`TRUE`;

  const rows = await sql<PairRow[]>`
    WITH l AS (
      SELECT * FROM jsonb_to_recordset(${sql.json(legs.map((x) => ({
        id: x.id,
        source: x.source,
        amount: x.amount,
        posted_at: x.posted_at,
        order_id: x.order_id,
      })))}::jsonb)
      AS t(id uuid, source text, amount numeric, posted_at timestamptz, order_id text)
    )
    SELECT l.id AS leg_id, c.id, c.source, c.external_id, c.posted_at,
           c.amount::float AS amount, c.counterparty, c.description,
           c.paypal_txn_id, c.order_id,
           (SELECT COUNT(*) FROM bank_transactions r
             WHERE r.id <> c.id AND ${liveFrag('r')}
               AND ${pairEligibleFrag(sql, 'c', 'r')}
               AND r.posted_at BETWEEN c.posted_at - ${win}::interval
                                   AND c.posted_at + ${win}::interval
           )::int AS reverse_count
    FROM l
    JOIN LATERAL (
      SELECT c.* FROM bank_transactions c
      WHERE c.id <> l.id AND ${liveFrag('c')}
        AND ${pairEligibleFrag(sql, 'l', 'c')}
        AND c.posted_at BETWEEN l.posted_at - ${win}::interval
                            AND l.posted_at + ${win}::interval
      ORDER BY ABS(EXTRACT(EPOCH FROM (c.posted_at - l.posted_at))) ASC, c.posted_at DESC
      LIMIT ${opts.limit}
    ) c ON TRUE`;

  const byId = new Map(legs.map((l) => [l.id, l]));
  for (const r of rows) {
    const leg = byId.get(r.leg_id);
    if (!leg) continue;
    const list = out.get(r.leg_id) ?? [];
    list.push({
      id: r.id,
      source: r.source,
      externalId: r.external_id,
      postedAt: r.posted_at,
      amount: Number(r.amount),
      counterparty: r.counterparty,
      description: r.description,
      paypalTxnId: r.paypal_txn_id,
      orderId: r.order_id,
      dayGap: dayGapOf(r.posted_at, leg.posted_at),
      reverseCount: Number(r.reverse_count),
    });
    out.set(r.leg_id, list);
  }
  return out;
}

// Ranking, in order: a PO that already has its money last, then a txn-id hit,
// exact amount over near, a matching seller name, the smaller day gap, a
// counterparty this purchaser has been paid for before, newest.
export function rankCandidates(leg: MatchLeg, rows: CandidateRow[]): RankedCandidate[] {
  const amt = Math.abs(leg.amount);
  const scored = rows.map((r) => {
    // A txn-id hit can carry a PO with no goods total yet, so every
    // amount-derived signal has to tolerate null rather than read it as 0.
    const cost = r.total_cost === null ? null : Number(r.total_cost);
    const diff = cost === null ? null : cost - amt;
    const exact = diff !== null && Math.abs(diff) < EXACT_EPSILON;
    return {
      id: r.id,
      totalCost: cost,
      createdAt: r.created_at,
      lifecycle: r.lifecycle,
      createdByName: r.created_by_name,
      reason: (r.txn_hit ? 'txn' : exact ? 'exact' : 'near') as MatchReason,
      dayGap: dayGapOf(r.created_at, leg.posted_at),
      amountDiff: diff === null ? null : Math.round(diff * 100) / 100,
      linkedTotal: Number(r.linked_total),
      sellerName: r.seller_name,
      affinity: r.affinity,
      // "Already has its money": a payment of the same size sits on the PO
      // already, so this is far more likely a different order than a second
      // leg of the same one.
      covered: cost !== null && cost > 0 && Number(r.linked_total) + EXACT_EPSILON >= cost,
      exact,
    };
  });

  scored.sort((a, b) =>
    Number(a.covered) - Number(b.covered)
    || Number(b.reason === 'txn') - Number(a.reason === 'txn')
    || Number(b.exact) - Number(a.exact)
    || Number(Boolean(b.sellerName)) - Number(Boolean(a.sellerName))
    || a.dayGap - b.dayGap
    || Number(b.affinity) - Number(a.affinity)
    || b.createdAt.getTime() - a.createdAt.getTime());

  // Confidence is relative: "the only exact match inside a week" is the whole
  // point, so it can only be decided once the full set is known.
  const strong = scored.filter((s) => s.exact && !s.covered && s.dayGap <= STRONG_WINDOW_DAYS);
  const exactAny = scored.filter((s) => s.exact && !s.covered);

  return scored.map(({ exact, ...s }) => {
    let confidence: MatchConfidence = 'low';
    // Covered comes first, and specifically before the txn-id branch: a
    // settlement leg that failed auto-pairing finds its own already-linked PO
    // by identifier, and `count === 1 && confidence === 'high'` is exactly what
    // arms the one-click Link that would pay it twice.
    if (s.covered) confidence = 'low';
    else if (s.reason === 'txn') confidence = 'high';
    else if (exact && s.dayGap <= STRONG_WINDOW_DAYS) {
      confidence = strong.length === 1 ? 'high' : 'medium';
    } else if (exact && exactAny.length === 1) confidence = 'medium';
    else if (s.sellerName) confidence = 'medium';
    return { ...s, confidence };
  });
}

// One round trip for a whole page of transactions: the legs arrive as arrays
// and LATERAL caps each pool, so this stays bounded instead of an N+1.
export async function fetchCandidatesBatch(
  sql: SqlClient,
  legs: MatchLeg[],
  limit: number,
): Promise<Map<string, CandidatePool>> {
  const out = new Map<string, CandidatePool>();
  if (legs.length === 0) return out;

  const rows = await sql<(CandidateRow & { leg_id: string })[]>`
    WITH l AS (
      SELECT * FROM jsonb_to_recordset(${sql.json(legs.map((x) => ({
        id: x.id,
        amount: Math.abs(x.amount),
        posted_at: x.posted_at,
        counterparty: x.counterparty ?? '',
        paypal_txn_id: x.paypal_txn_id ?? '',
      })))}::jsonb)
      AS t(id text, amount numeric, posted_at timestamptz, counterparty text, paypal_txn_id text)
    )
    SELECT l.id AS leg_id,
           o.id,
           o.total_cost::float AS total_cost,
           o.created_at,
           o.lifecycle,
           o.txn_hit,
           o.pool_total::int AS pool_total,
           u.name AS created_by_name,
           -- Signed, and one row per logical payment: a paired charge writes
           -- both legs, and a refund is money back. Summing ABS() over every
           -- leg reported a $1,000 paired payment as $2,000 and read a
           -- refunded PO as fully paid. Same guard GET /by-order/:id uses.
           COALESCE((
             SELECT -SUM(bt.amount) FROM bank_transactions bt
             WHERE bt.order_id = o.id AND NOT bt.ignored
               AND (bt.pair_id IS NULL OR bt.source = 'paypal')
               -- PayPal reverses a payment in place, keeping the transaction
               -- id, so a linked row can turn into money that came back. Left
               -- in, the PO would go on reading as fully paid.
               AND bt.settle_status <> 'failed' AND bt.settle_status <> 'reversed'
           ), 0)::float AS linked_total,
           ${sellerNameFrag(sql, 'l')} AS seller_name,
           EXISTS (
             SELECT 1 FROM bank_transactions bt2
             JOIN orders o2 ON o2.id = bt2.order_id
             WHERE l.counterparty <> '' AND bt2.counterparty = l.counterparty
               AND o2.user_id = o.user_id AND o2.id <> o.id
           ) AS affinity
    FROM l
    JOIN LATERAL (
      -- The cap has to drop the weakest candidates, not the oldest: ordering
      -- by created_at before ranking evicted exactly the case txnHitFrag
      -- exists for, a months-old PO carrying the payment's identifier.
      SELECT o.*, cand.txn_hit, COUNT(*) OVER () AS pool_total
      FROM (
        SELECT id, bool_or(txn) AS txn_hit FROM (
          SELECT a.id, FALSE AS txn FROM orders a
          WHERE a.archived_at IS NULL AND ${amountDateFrag(sql, 'l', 'a')}
          UNION ALL
          SELECT b.id, TRUE AS txn FROM orders b
          WHERE b.archived_at IS NULL AND ${txnHitFrag(sql, 'l', 'b')}
        ) u GROUP BY id
      ) cand
      JOIN orders o ON o.id = cand.id
      ORDER BY cand.txn_hit DESC,
               LEAST(ABS(o.total_cost - l.amount),
                     ABS(o.total_cost + o.other_fees - l.amount)) ASC NULLS LAST,
               o.created_at DESC
      LIMIT ${limit}
    ) o ON TRUE
    JOIN users u ON u.id = o.user_id`;

  const byLeg = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    const list = byLeg.get(r.leg_id);
    if (list) list.push(r);
    else byLeg.set(r.leg_id, [r]);
  }
  for (const leg of legs) {
    const pool = byLeg.get(leg.id);
    if (pool) out.set(leg.id, { ranked: rankCandidates(leg, pool), total: Number(pool[0].pool_total) });
  }
  return out;
}

export async function fetchCandidates(
  sql: SqlClient,
  leg: MatchLeg,
): Promise<CandidatePool> {
  return (await fetchCandidatesBatch(sql, [leg], CANDIDATE_CAP)).get(leg.id)
    ?? { ranked: [], total: 0 };
}

export async function matchSummaries(
  sql: SqlClient,
  legs: MatchLeg[],
): Promise<Map<string, MatchSummary>> {
  const out = new Map<string, MatchSummary>();
  const batch = await fetchCandidatesBatch(sql, legs, CANDIDATE_CAP);
  for (const [legId, { ranked, total }] of batch) {
    if (ranked.length === 0) continue;
    const best = ranked[0];
    out.set(legId, {
      count: total,
      shown: ranked.length,
      confidence: best.confidence,
      best: {
        id: best.id,
        totalCost: best.totalCost,
        createdAt: best.createdAt,
        dayGap: best.dayGap,
        createdByName: best.createdByName,
      },
    });
  }
  return out;
}
