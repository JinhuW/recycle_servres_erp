import { Hono } from 'hono';
import type postgres from 'postgres';
import { getDb, type SqlLike } from '../db';
import { nextHumanId } from '../lib/id-seq';
import { getLatestRateToUsd } from '../lib/fx';
import { poRealizedLateral } from '../lib/po-cost';
import { allLimited } from '../lib/concurrency';
import {
  clampLimit, cursorTs, cursorTsParam, cursorTsSelect, decodeCursor, encodeCursor, escapeLike, UUID_RE,
} from '../lib/pagination';
import { isActiveManager } from '../services/members';
import { commissionLinkedFrag } from '../banktx/match';
import { notify } from '../lib/notify';
import { authMiddleware } from '../auth';
import { requireManager } from '../lib/role';
import { lockPayerTx, paidByErr, recordPayerTx, type CommissionPaidBy, type PayerRow } from './orders/shared';
import { writeOrderEvent, type AuditChange } from '../services/orderAudit';
import { nameHandoffByChange } from '../services/orderHandoff';
import type { Env, User } from '../types';
import {
  ACCOUNTING_DUPLICATE_DAYS, ACCOUNTING_KINDS, ACCOUNTING_QUERY_MAX, ACCOUNTING_REVIEW_TABS,
  ACCOUNTING_UNREVIEWED_FIELDS, KIND_TARGET,
  accountingChecks, addDays, hasAccountingWarning, isAccountingCurrency, isAccountingDirection, isAccountingKind,
  isAccountingMethod, isAccountingReviewState, isIsoDate, todayIn,
  type AccountingCurrency, type AccountingDirection, type AccountingKind, type AccountingMethod,
  type AccountingReviewFacts, type AccountingReviewState, type AccountingReviewTab, type AccountingTargetType,
} from '@recycle-erp/shared';

// The RMB Flow: the managers' book of money received and paid outside the
// company's own account, in RMB. The Business Account's money is the USD
// bank's, reconciled on Payments. An entry is a record of money that moved —
// it changes nothing on the PO, sell order or case it names, with one
// exception: who paid. An entry's Paid by and its PO's payer are one value,
// kept in step both ways: this file writes the entry's side to the PO, and
// migration 0199's triggers write the PO's side to its entries — a PO the
// Business Account paid voids them, and this file refuses a new one there.
const accounting = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

// A mistyped amount or rate is refused here rather than overflowing amount_cny.
const MAX_AMOUNT = 1_000_000_000;
const MAX_RATE = 100;
const MAX_SHORT = 200;
const MAX_NOTE = 2000;
const EARLIEST = '2000-01-01';

type EventKind =
  | 'created' | 'edited' | 'voided' | 'restored' | 'unlinked'
  | 'reviewed' | 'unreviewed' | 'queried' | 'answered' | 'query_withdrawn';
type Frag = postgres.PendingQuery<postgres.Row[]>;

// ── Reading entries ─────────────────────────────────────────────────────────

type EntryRow = {
  id: string; direction: AccountingDirection; kind: AccountingKind;
  amount: number; currency: AccountingCurrency; fx_rate: number | null; amount_cny: number;
  method: AccountingMethod; occurred_on: string;
  manager_id: string; manager_name: string;
  order_id: string | null; sell_order_id: string | null; after_sales_id: string | null;
  counterparty: string | null; reference: string | null; note: string | null;
  created_at: string; updated_at: string; created_by: string | null; created_by_name: string | null;
  voided_at: string | null; void_reason: string | null; voided_by_name: string | null;
  author_id: string | null; author_name: string | null;
  reviewed_by: string | null; reviewed_by_name: string | null; reviewed_at: string | null;
  review_cleared_at: string | null;
  query_by: string | null; query_by_name: string | null; query_text: string | null; query_at: string | null;
  answer_by: string | null; answer_by_name: string | null; answer_text: string | null; answer_at: string | null;
  version: string;
};

function entryCols(sql: SqlLike) {
  return sql`
    e.id, e.direction, e.kind, e.amount::float AS amount, e.currency, e.fx_rate::float AS fx_rate,
    e.amount_cny::float AS amount_cny, e.method, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
    e.manager_id, m.name AS manager_name, e.order_id, e.sell_order_id, e.after_sales_id,
    e.counterparty, e.reference, e.note, e.created_at, e.updated_at,
    e.created_by, cb.name AS created_by_name, e.voided_at, e.void_reason, vb.name AS voided_by_name,
    e.author_id, au.name AS author_name, e.reviewed_by, rv.name AS reviewed_by_name, e.reviewed_at,
    e.review_cleared_at, e.query_by, qb.name AS query_by_name, e.query_text, e.query_at,
    e.answer_by, ab.name AS answer_by_name, e.answer_text, e.answer_at,
    e.updated_at::text AS version
  `;
}

function entryJoins(sql: SqlLike) {
  return sql`
    JOIN users m ON m.id = e.manager_id
    LEFT JOIN users cb ON cb.id = e.created_by
    LEFT JOIN users vb ON vb.id = e.voided_by
    LEFT JOIN users au ON au.id = e.author_id
    LEFT JOIN users rv ON rv.id = e.reviewed_by
    LEFT JOIN users qb ON qb.id = e.query_by
    LEFT JOIN users ab ON ab.id = e.answer_by
  `;
}

function targetOf(r: { order_id: string | null; sell_order_id: string | null; after_sales_id: string | null }) {
  if (r.order_id) return { type: 'po' as const, id: r.order_id };
  if (r.sell_order_id) return { type: 'so' as const, id: r.sell_order_id };
  if (r.after_sales_id) return { type: 'as' as const, id: r.after_sales_id };
  return null;
}

// The derived state, in the order the migration (0197) states it.
function reviewStateOf(r: Pick<EntryRow, 'reviewed_at' | 'query_at' | 'answer_at' | 'review_cleared_at'>): AccountingReviewState {
  if (r.reviewed_at) return 'reviewed';
  if (r.query_at && !r.answer_at) return 'queried';
  return r.review_cleared_at ? 'changed' : 'open';
}

const reviewStateSql = (sql: SqlLike) => sql`CASE
  WHEN e.reviewed_at IS NOT NULL THEN 'reviewed'
  WHEN e.query_at IS NOT NULL AND e.answer_at IS NULL THEN 'queried'
  WHEN e.review_cleared_at IS NOT NULL THEN 'changed'
  ELSE 'open' END`;

const person = (id: string | null, name: string | null) => (id ? { id, name: name ?? '' } : null);

// Who a question goes to: the author, or for an entry nobody wrote (the 0196
// backfill) the manager whose money it was.
const addresseeOf = (r: Pick<EntryRow, 'author_id' | 'manager_id'>) => r.author_id ?? r.manager_id;

function shapeReview(r: EntryRow) {
  if (r.voided_at) return null;
  return {
    state: reviewStateOf(r),
    // What a sign-off names, so a page that is out of date can't sign off
    // something it never showed.
    version: r.version,
    author: person(r.author_id, r.author_name),
    by: person(r.reviewed_by, r.reviewed_by_name),
    at: r.reviewed_at,
    clearedAt: r.review_cleared_at,
    query: r.query_at ? {
      by: person(r.query_by, r.query_by_name), text: r.query_text ?? '', at: r.query_at,
      to: person(addresseeOf(r), r.author_id ? r.author_name : r.manager_name),
      answer: r.answer_at ? { by: person(r.answer_by, r.answer_by_name), text: r.answer_text, at: r.answer_at } : null,
    } : null,
  };
}

function shapeEntry(r: EntryRow) {
  return {
    id: r.id, direction: r.direction, kind: r.kind,
    amount: r.amount, currency: r.currency, fxRate: r.fx_rate, amountCny: r.amount_cny,
    method: r.method, occurredOn: r.occurred_on,
    manager: { id: r.manager_id, name: r.manager_name },
    target: targetOf(r),
    counterparty: r.counterparty, reference: r.reference, note: r.note,
    createdAt: r.created_at, updatedAt: r.updated_at,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name } : null,
    voided: r.voided_at ? { at: r.voided_at, by: r.voided_by_name, reason: r.void_reason } : null,
    review: shapeReview(r),
  };
}

// Received counts up, paid down: the book's one sign convention.
const signedCny = (sql: SqlLike) =>
  sql`CASE WHEN e.direction = 'in' THEN e.amount_cny ELSE -e.amount_cny END`;

// ── What an entry is for ────────────────────────────────────────────────────
// A record's own figure, in its own currency, for the picker and the cards:
// a PO's cost or projected commission (USD), a sell order's total in the
// currency it was sold in, a case's amount (USD).

type TargetFacts = {
  id: string; status: string; party: string | null; amount: number | null; currency: AccountingCurrency;
  recordedCny: number;
  // Whose hands the money went through, when the record says: a PO's cost
  // payer or commission payer. The form offers it as the manager; a payer
  // who is not an active manager falls back to the recorder there.
  payerId?: string | null;
  // The payer as the picker reads it: the person's name, or the Business
  // Account — a cost paid from the company's account, or a commission the
  // company paid (on file, or a live Mercury/PayPal row linked as it).
  payerName?: string | null;
  payerBusiness?: boolean;
  // The purchaser may be a self-paid cost's payer.
  owner?: { id: string; name: string };
};

type TargetLens = 'purchase' | 'commission' | 'so' | 'as';

const LENS_OF: Record<Exclude<AccountingKind, 'other'>, TargetLens> = {
  purchase: 'purchase', commission: 'commission', sale: 'so', after_sales: 'as',
};

// What the book has against a record, signed the way the record reads it: a
// PO and a case are paid, a sell order is received. A sell order's figure
// takes in its cases' refunds too — that money went back to the same buyer.
function recordedFrag(sql: SqlLike, lens: TargetLens, idCol: Frag) {
  const live = sql`e.voided_at IS NULL`;
  switch (lens) {
    case 'purchase':
    case 'commission':
      return sql`(SELECT COALESCE(SUM(-${signedCny(sql)}), 0)::float FROM accounting_entries e
                  WHERE e.order_id = ${idCol} AND e.kind = ${lens} AND ${live})`;
    case 'so':
      return sql`(SELECT COALESCE(SUM(${signedCny(sql)}), 0)::float FROM accounting_entries e
                  WHERE ${live} AND (e.sell_order_id = ${idCol}
                    OR e.after_sales_id IN (SELECT id FROM after_sales_cases WHERE sell_order_id = ${idCol})))`;
    case 'as':
      return sql`(SELECT COALESCE(SUM(-${signedCny(sql)}), 0)::float FROM accounting_entries e
                  WHERE e.after_sales_id = ${idCol} AND ${live})`;
  }
}

async function findTargets(
  sql: SqlLike, lens: TargetLens, opts: { id?: string; ids?: string[]; q?: string },
): Promise<TargetFacts[]> {
  const like = opts.q ? `%${escapeLike(opts.q)}%` : null;
  // Review mode asks for every record its rows name at once.
  const limit = opts.ids ? opts.ids.length : 10;
  if (opts.ids && opts.ids.length === 0) return [];
  if (lens === 'purchase' || lens === 'commission') {
    const scope = opts.ids ? sql`o.id = ANY(${opts.ids})`
      : opts.id ? sql`o.id = ${opts.id}`
      : like ? sql`o.archived_at IS NULL AND (o.id ILIKE ${like} OR sup.name ILIKE ${like} OR u.name ILIKE ${like})`
      // Commission is owed once the review is finished.
      : lens === 'commission' ? sql`o.archived_at IS NULL AND o.lifecycle IN ('ready_to_pay', 'done')`
      : sql`o.archived_at IS NULL`;
    // The projected commission is the bank picker's (routes/bankTx.ts): the
    // margin as bought, clamped at zero, times the rate.
    const amount = lens === 'commission'
      ? sql`(GREATEST(rz.projected_profit, 0) * o.commission_rate)::float`
      : sql`(COALESCE(o.total_cost, 0) + o.other_fees)::float`;
    const payerCol = lens === 'commission' ? sql`o.commission_paid_by` : sql`o.paid_by`;
    // The Business Account: a cost paid as 'company', or a commission the
    // company paid — by hand, or because a live bank row is linked as it
    // (the same read the PO's own Paid by makes, routes/orders/shared.ts).
    const business = lens === 'commission'
      ? sql`(o.commission_paid_by_company OR ${commissionLinkedFrag(sql)})`
      : sql`(o.payment = 'company')`;
    const rows = await sql<{
      id: string; status: string; party: string | null; amount: number | null; recorded: number;
      payer_id: string | null; payer_name: string | null; payer_business: boolean;
      owner_id: string; owner_name: string;
    }[]>`
      SELECT o.id, o.lifecycle AS status,
             ${lens === 'commission' ? sql`u.name` : sql`COALESCE(sup.name, u.name)`} AS party,
             ${amount} AS amount, ${recordedFrag(sql, lens, sql`o.id`)} AS recorded,
             ${payerCol} AS payer_id, pb.name AS payer_name, ${business} AS payer_business,
             u.id AS owner_id, u.name AS owner_name
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN users pb ON pb.id = ${payerCol}
      LEFT JOIN suppliers sup ON sup.id = o.supplier_id
      ${poRealizedLateral(sql, lens === 'commission')}
      WHERE ${scope}
      ORDER BY o.created_at DESC
      LIMIT ${limit}`;
    return rows.map(({ payer_id, payer_name, payer_business, owner_id, owner_name, ...r }) => ({
      ...r, currency: 'USD' as const, recordedCny: r.recorded,
      payerId: payer_business ? null : payer_id,
      payerName: payer_business ? null : payer_name,
      payerBusiness: payer_business,
      owner: { id: owner_id, name: owner_name },
    }));
  }
  if (lens === 'so') {
    const scope = opts.ids ? sql`so.id = ANY(${opts.ids})`
      : opts.id ? sql`so.id = ${opts.id}`
      : like ? sql`so.archived_at IS NULL AND (so.id ILIKE ${like} OR cu.name ILIKE ${like})`
      // Where a buyer's money arrives: shipped and waiting, or already done.
      : sql`so.archived_at IS NULL AND so.status IN ('Shipped', 'Awaiting payment', 'Done')`;
    const rows = await sql<{
      id: string; status: string; party: string | null; amount: number; currency: AccountingCurrency; recorded: number;
    }[]>`
      SELECT so.id, so.status, cu.name AS party, t.total AS amount, so.currency_code AS currency,
             ${recordedFrag(sql, 'so', sql`so.id`)} AS recorded
      FROM sell_orders so
      JOIN customers cu ON cu.id = so.customer_id
      JOIN LATERAL (
        SELECT COALESCE(SUM(sol.qty * COALESCE(sol.source_unit_price, sol.unit_price)), 0)::float AS total
        FROM sell_order_lines sol WHERE sol.sell_order_id = so.id
      ) t ON TRUE
      WHERE ${scope}
      ORDER BY so.created_at DESC
      LIMIT ${limit}`;
    return rows.map(r => ({ ...r, recordedCny: r.recorded }));
  }
  const scope = opts.ids ? sql`c.id = ANY(${opts.ids})`
    : opts.id ? sql`c.id = ${opts.id}`
    : like ? sql`(c.id ILIKE ${like} OR so.id ILIKE ${like} OR cu.name ILIKE ${like})`
    : sql`TRUE`;
  const rows = await sql<{
    id: string; status: string; party: string | null; amount: number | null; recorded: number;
  }[]>`
    SELECT c.id, c.status, cu.name AS party, c.amount::float AS amount,
           ${recordedFrag(sql, 'as', sql`c.id`)} AS recorded
    FROM after_sales_cases c
    JOIN sell_orders so ON so.id = c.sell_order_id
    JOIN customers cu ON cu.id = so.customer_id
    WHERE ${scope}
    ORDER BY (c.status IN ('Resolved', 'Cancelled')), c.created_at DESC
    LIMIT ${limit}`;
  return rows.map(r => ({ ...r, currency: 'USD' as const, recordedCny: r.recorded }));
}

// CNY per 1 USD, the way the book stores it; the fx module works the other
// way round.
async function latestCnyPerUsd(sql: SqlLike) {
  const lookup = await getLatestRateToUsd(sql, 'CNY');
  // 1/(1/x) carries float noise; the stored rate has eight places.
  return { rate: Math.round(1e8 / lookup.rate) / 1e8, source: lookup.source, effectiveDate: lookup.effectiveDate };
}

// ── Summary ─────────────────────────────────────────────────────────────────

function parseWindow(from: string | undefined, to: string | undefined) {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return null;
  return { from, to };
}

function parseManager(raw: string | undefined): string | null | undefined {
  if (!raw) return null;
  return UUID_RE.test(raw) ? raw : undefined;
}

const payerFrag = (sql: SqlLike, managerId: string) => sql`e.manager_id = ${managerId}`;

// The period as the book states it: what was brought in, what came and went,
// and what was carried out — opening + received − paid = closing — plus each
// manager's own balance on the closing date.
accounting.get('/summary', async (c) => {
  const me = c.var.user.id;
  const win = parseWindow(c.req.query('from'), c.req.query('to'));
  if (!win) return c.json({ error: 'from and to must be dates, from on or before to' }, 400);
  const managerId = parseManager(c.req.query('managerId'));
  if (managerId === undefined) return c.json({ error: 'invalid managerId' }, 400);
  const sql = getDb(c.env);
  const mgr = managerId ? sql`AND ${payerFrag(sql, managerId)}` : sql`AND TRUE`;
  const live = sql`e.voided_at IS NULL AND e.occurred_on <= ${win.to}::date ${mgr}`;
  const inWindow = sql`e.occurred_on >= ${win.from}::date`;

  const state = reviewStateSql(sql);
  const [totals, byKind, managers, first, fx, review] = await allLimited([
    () => sql<{ opening: number; received: number; paid: number; closing: number }[]>`
      SELECT
        COALESCE(SUM(${signedCny(sql)}) FILTER (WHERE e.occurred_on < ${win.from}::date), 0)::float AS opening,
        COALESCE(SUM(e.amount_cny) FILTER (WHERE ${inWindow} AND e.direction = 'in'), 0)::float AS received,
        COALESCE(SUM(e.amount_cny) FILTER (WHERE ${inWindow} AND e.direction = 'out'), 0)::float AS paid,
        COALESCE(SUM(${signedCny(sql)}), 0)::float AS closing
      FROM accounting_entries e WHERE ${live}`,
    () => sql<{ kind: AccountingKind; received: number; paid: number; count: number }[]>`
      SELECT e.kind,
             COALESCE(SUM(e.amount_cny) FILTER (WHERE e.direction = 'in'), 0)::float AS received,
             COALESCE(SUM(e.amount_cny) FILTER (WHERE e.direction = 'out'), 0)::float AS paid,
             COUNT(*)::int AS count
      FROM accounting_entries e WHERE ${live} AND ${inWindow}
      GROUP BY e.kind`,
    // Every active manager, and anyone else who still holds a balance.
    () => sql<{ id: string; name: string; balance: number }[]>`
      SELECT u.id, u.name, COALESCE(b.balance, 0)::float AS balance
      FROM users u
      LEFT JOIN (
        SELECT e.manager_id, SUM(${signedCny(sql)}) AS balance
        FROM accounting_entries e
        WHERE e.voided_at IS NULL AND e.occurred_on <= ${win.to}::date
        GROUP BY e.manager_id
      ) b ON b.manager_id = u.id
      WHERE (u.role = 'manager' AND u.active) OR b.manager_id IS NOT NULL
      ORDER BY u.name`,
    () => sql<{ first: string | null }[]>`
      SELECT to_char(MIN(occurred_on), 'YYYY-MM-DD') AS first
      FROM accounting_entries WHERE voided_at IS NULL`,
    () => latestCnyPerUsd(sql),
    // The period's review, over the band's own scope.
    () => sql<{
      entries: number; reviewed: number; changed: number; queried: number; for_me: number; waiting: number;
      moved_cny: number; reviewed_cny: number; active_managers: number;
    }[]>`
      SELECT COUNT(*)::int AS entries,
             COUNT(*) FILTER (WHERE ${state} = 'reviewed')::int AS reviewed,
             COUNT(*) FILTER (WHERE ${state} = 'changed')::int AS changed,
             COUNT(*) FILTER (WHERE ${state} = 'queried')::int AS queried,
             COUNT(*) FILTER (WHERE ${state} IN ('open', 'changed') AND e.author_id IS DISTINCT FROM ${me})::int AS for_me,
             COUNT(*) FILTER (WHERE ${state} IN ('open', 'changed') AND e.author_id = ${me})::int AS waiting,
             COALESCE(SUM(e.amount_cny), 0)::float AS moved_cny,
             COALESCE(SUM(e.amount_cny) FILTER (WHERE ${state} = 'reviewed'), 0)::float AS reviewed_cny,
             (SELECT COUNT(*)::int FROM users WHERE role = 'manager' AND active) AS active_managers
      FROM accounting_entries e WHERE ${live} AND ${inWindow}`,
  ]);
  const rv = review[0];

  const kinds = Object.fromEntries(ACCOUNTING_KINDS.map(k => [k, { received: 0, paid: 0, count: 0 }]));
  for (const r of byKind) kinds[r.kind] = { received: r.received, paid: r.paid, count: r.count };
  return c.json({
    from: win.from, to: win.to,
    ...totals[0],
    byKind: kinds,
    managers,
    first: first[0]?.first ?? null,
    fx,
    review: {
      entries: rv.entries, reviewed: rv.reviewed, changed: rv.changed, queried: rv.queried,
      forMe: rv.for_me, waitingOnOthers: rv.waiting, movedCny: rv.moved_cny, reviewedCny: rv.reviewed_cny,
      activeManagers: rv.active_managers,
    },
  });
});

// ── The ledger ──────────────────────────────────────────────────────────────

// `ts` carries the day and the µs timestamp, since the shared cursor holds
// one sort value and the book sorts on two.
function parseBookCursor(raw: string | undefined) {
  const c = decodeCursor(raw);
  if (!c || typeof c.ts !== 'string') return null;
  const [day, rest] = c.ts.split('_');
  const ts = cursorTs({ ts: rest ?? '', id: c.id });
  return isIsoDate(day) && ts ? { day, ts, id: c.id } : null;
}

accounting.get('/entries', async (c) => {
  const sql = getDb(c.env);
  const q = (k: string) => c.req.query(k);
  const managerId = parseManager(q('managerId'));
  if (managerId === undefined) return c.json({ error: 'invalid managerId' }, 400);
  const from = q('from');
  const to = q('to');
  if ((from !== undefined && !isIsoDate(from)) || (to !== undefined && !isIsoDate(to))) {
    return c.json({ error: 'from and to must be dates' }, 400);
  }
  const direction = q('direction');
  if (direction !== undefined && !isAccountingDirection(direction)) return c.json({ error: 'unknown direction' }, 400);
  const kind = q('kind');
  if (kind !== undefined && !isAccountingKind(kind)) return c.json({ error: 'unknown kind' }, 400);
  const method = q('method');
  if (method !== undefined && !isAccountingMethod(method)) return c.json({ error: 'unknown method' }, 400);
  const review = q('review');
  if (review !== undefined && !isAccountingReviewState(review)) return c.json({ error: 'unknown review state' }, 400);
  const search = (q('q') ?? '').trim().slice(0, 200);
  const like = `%${escapeLike(search)}%`;
  const limit = clampLimit(q('limit'), 100, 200);
  const cursor = parseBookCursor(q('cursor'));

  const frags = [
    from ? sql`e.occurred_on >= ${from}::date` : null,
    to ? sql`e.occurred_on <= ${to}::date` : null,
    direction ? sql`e.direction = ${direction}` : null,
    kind ? sql`e.kind = ${kind}` : null,
    method ? sql`e.method = ${method}` : null,
    managerId ? payerFrag(sql, managerId) : null,
    review ? sql`e.voided_at IS NULL AND ${reviewStateSql(sql)} = ${review}` : null,
    q('voided') === '1' ? null : sql`e.voided_at IS NULL`,
    search ? sql`(e.id ILIKE ${like} OR e.counterparty ILIKE ${like} OR e.reference ILIKE ${like}
                  OR e.note ILIKE ${like} OR e.order_id ILIKE ${like} OR e.sell_order_id ILIKE ${like}
                  OR e.after_sales_id ILIKE ${like})` : null,
    cursor ? sql`(e.occurred_on, e.created_at, e.id)
                 < (${cursor.day}::date, ${cursorTsParam(sql, cursor.ts)}, ${cursor.id})` : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);
  const where = frags.reduce((acc, f) => sql`${acc} AND ${f}`, sql`TRUE`);

  // The balance runs over the whole book before any filter — the payer
  // included — so hiding rows never changes what a row says is left after it.
  const rows = await sql<(EntryRow & { balance: number | null; cursor_ts: string })[]>`
    WITH book AS (
      SELECT e.id,
             SUM(${signedCny(sql)}) FILTER (WHERE e.voided_at IS NULL)
               OVER (ORDER BY e.occurred_on, e.created_at, e.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
      FROM accounting_entries e
    )
    SELECT ${entryCols(sql)},
           CASE WHEN e.voided_at IS NULL THEN COALESCE(b.balance, 0)::float END AS balance,
           ${cursorTsSelect(sql, sql`e.created_at`)} AS cursor_ts
    FROM book b
    JOIN accounting_entries e ON e.id = b.id
    ${entryJoins(sql)}
    WHERE ${where}
    ORDER BY e.occurred_on DESC, e.created_at DESC, e.id DESC
    LIMIT ${limit + 1}`;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return c.json({
    rows: page.map(r => ({ ...shapeEntry(r), balance: r.balance })),
    nextCursor: hasMore && last ? encodeCursor({ ts: `${last.occurred_on}_${last.cursor_ts}`, id: last.id }) : null,
  });
});

accounting.get('/entries/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const row = (await sql<EntryRow[]>`
    SELECT ${entryCols(sql)} FROM accounting_entries e ${entryJoins(sql)} WHERE e.id = ${id} LIMIT 1
  `)[0];
  if (!row) return c.json({ error: 'Not found' }, 404);
  const entry = shapeEntry(row);
  const lens = row.kind === 'other' ? null : LENS_OF[row.kind];
  const [events, target] = await allLimited([
    () => sql<{
      id: string; kind: EventKind; detail: Record<string, unknown>; created_at: string;
      actor_id: string | null; actor_name: string | null;
    }[]>`
      SELECT ev.id, ev.kind, ev.detail, ev.created_at, u.id AS actor_id, u.name AS actor_name
      FROM accounting_entry_events ev LEFT JOIN users u ON u.id = ev.actor_id
      WHERE ev.entry_id = ${id} ORDER BY ev.created_at, ev.id`,
    () => (lens && entry.target ? findTargets(sql, lens, { id: entry.target.id }) : Promise.resolve([])),
  ]);
  return c.json({
    entry: {
      ...entry,
      targetFacts: target[0] ?? null,
      events: events.map(e => ({
        id: e.id, kind: e.kind, detail: e.detail, at: e.created_at,
        actor: e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
      })),
    },
  });
});

// ── Writing entries ─────────────────────────────────────────────────────────

type EntryFields = {
  direction: AccountingDirection; kind: AccountingKind; amount: number; currency: AccountingCurrency;
  fxRate: number | null; method: AccountingMethod; occurredOn: string; managerId: string;
  targetId: string | null; counterparty: string | null; reference: string | null; note: string | null;
};

const optText = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v.trim() || null;
};

const TARGET_NAME: Record<AccountingTargetType, string> = {
  po: 'purchase order', so: 'sell order', as: 'after-sales case',
};

// Every field checked together, so a PATCH is judged on the entry it would
// leave behind rather than on the keys it happened to send. `orphan` lets an
// entry whose record was deleted keep its kind with no link.
function validateFields(
  b: Record<string, unknown>, opts: { orphan?: boolean } = {},
): { fields: EntryFields } | { error: string } {
  if (!isAccountingDirection(b.direction)) return { error: 'direction must be in or out' };
  if (!isAccountingKind(b.kind)) return { error: `kind must be one of ${ACCOUNTING_KINDS.join(', ')}` };
  const amount = typeof b.amount === 'number' ? b.amount : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return { error: 'amount must be a positive number up to 1,000,000,000' };
  }
  if (!isAccountingCurrency(b.currency)) return { error: 'currency must be CNY or USD' };
  let fxRate: number | null = null;
  if (b.currency === 'USD' && b.fxRate !== undefined && b.fxRate !== null) {
    if (typeof b.fxRate !== 'number' || !Number.isFinite(b.fxRate) || b.fxRate <= 0 || b.fxRate > MAX_RATE) {
      return { error: 'fxRate must be the CNY paid for 1 USD, between 0 and 100' };
    }
    fxRate = b.fxRate;
  }
  if (!isAccountingMethod(b.method)) return { error: 'unknown method' };
  // A calendar date from anywhere on Earth: up to a day past UTC's today.
  const latest = addDays(todayIn('UTC'), 1);
  if (!isIsoDate(b.occurredOn) || b.occurredOn < EARLIEST || b.occurredOn > latest) {
    return { error: 'occurredOn must be a date no later than today' };
  }
  if (typeof b.managerId !== 'string' || !UUID_RE.test(b.managerId)) return { error: 'managerId is required' };
  const wants = KIND_TARGET[b.kind];
  const targetId = b.targetId === undefined || b.targetId === null || b.targetId === '' ? null : b.targetId;
  if (targetId !== null && typeof targetId !== 'string') return { error: 'invalid targetId' };
  if (wants && !targetId && !opts.orphan) return { error: `a ${b.kind} entry names its ${TARGET_NAME[wants]}` };
  if (!wants && targetId) return { error: 'an other entry names no record' };
  const counterparty = optText(b.counterparty, MAX_SHORT);
  const reference = optText(b.reference, MAX_SHORT);
  const note = optText(b.note, MAX_NOTE);
  if (counterparty === undefined || reference === undefined || note === undefined) {
    return { error: 'counterparty and reference take up to 200 characters, a note up to 2000' };
  }
  return {
    fields: {
      direction: b.direction, kind: b.kind, amount: Math.round(amount * 100) / 100, currency: b.currency,
      fxRate, method: b.method, occurredOn: b.occurredOn, managerId: b.managerId,
      targetId: targetId as string | null, counterparty, reference, note,
    },
  };
}

const targetColumns = (kind: AccountingKind, targetId: string | null) => {
  const t = KIND_TARGET[kind];
  return {
    order_id: t === 'po' ? targetId : null,
    sell_order_id: t === 'so' ? targetId : null,
    after_sales_id: t === 'as' ? targetId : null,
  };
};

async function writeEvent(tx: SqlLike, entryId: string, actorId: string, kind: EventKind, detail: Record<string, unknown> = {}) {
  await tx`
    INSERT INTO accounting_entry_events (entry_id, kind, detail, actor_id)
    VALUES (${entryId}, ${kind}, ${tx.json(detail as never)}, ${actorId})`;
}

// A PO's cost payer, locked for the caller's write.
type CostRow = { payment: 'company' | 'self'; paid_by: string | null; user_id: string };

type Prepared =
  | { kind: 'missing'; what: AccountingTargetType }
  | { kind: 'ok'; payer: PayerRow | null; cost: CostRow | null };

const NO_PO: Prepared = { kind: 'ok', payer: null, cost: null };

// Confirms the record exists and holds it until commit, so a delete can't
// slip between the check and the insert's FK. A paid commission or cost
// locks its PO for the payer write-back instead — the orders row is the one
// lock taken first.
async function prepareTargetTx(tx: SqlLike, f: EntryFields): Promise<Prepared> {
  const type = KIND_TARGET[f.kind];
  if (!type || !f.targetId) return NO_PO;
  if (f.kind === 'commission' && f.direction === 'out') {
    const payer = await lockPayerTx(tx, f.targetId);
    return payer ? { kind: 'ok', payer, cost: null } : { kind: 'missing', what: 'po' };
  }
  if (f.kind === 'purchase' && f.direction === 'out') {
    const cost = (await tx<CostRow[]>`
      SELECT payment, paid_by, user_id FROM orders WHERE id = ${f.targetId} LIMIT 1 FOR NO KEY UPDATE`)[0];
    return cost ? { kind: 'ok', payer: null, cost } : { kind: 'missing', what: 'po' };
  }
  const table = type === 'po' ? tx`orders` : type === 'so' ? tx`sell_orders` : tx`after_sales_cases`;
  const found = await tx`SELECT 1 FROM ${table} WHERE id = ${f.targetId} LIMIT 1 FOR KEY SHARE`;
  return found.length ? NO_PO : { kind: 'missing', what: type };
}

// ── The two-way link with the PO (0199) ─────────────────────────────────────
// An entry's Paid by and its PO's payer are one value. The PO's side flows
// to the entry in the database (accounting_sync_payer and its triggers);
// this is the entry's side flowing to the PO. A PO the Business Account paid
// — the commission flagged company-paid or a bank row standing as it, the
// cost paid from the company's account — takes no RMB entry: that money is
// Payments', and the flag or the link is undone on the PO.

type Refused = { status: 400 | 409; error: string };

const LINKED_MSG = 'a Mercury/PayPal row is linked as the commission — it was paid from the Business Account, see Payments';
const COMPANY_COMMISSION_MSG = 'the commission was paid from the Business Account — change that on the PO';
const COMPANY_COST_MSG = 'the cost was paid from the Business Account — change that on the PO';

// Who may be the payer: an active manager, or — for a self-paid cost — the
// PO's own purchaser (routes/orders/shared.ts paidByErr).
async function payerAllowedTx(tx: SqlLike, f: EntryFields, prepared: Prepared & { kind: 'ok' }): Promise<Refused | null> {
  if (prepared.cost) {
    if (prepared.cost.payment === 'company') return { status: 409, error: COMPANY_COST_MSG };
    const err = await paidByErr(tx, prepared.cost.user_id, f.managerId);
    return err ? { status: 400, error: err } : null;
  }
  if (prepared.payer?.commission_linked) return { status: 409, error: LINKED_MSG };
  if (prepared.payer?.commission_paid_by_company) return { status: 409, error: COMPANY_COMMISSION_MSG };
  return (await isActiveManager(tx, f.managerId)) ? null : { status: 400, error: 'managerId must be an active manager' };
}

// Writes the entry's payer to the PO when it differs. Returns the PO's
// commission payer when it wrote one, for the response.
async function syncPayerToPoTx(
  tx: SqlLike, f: EntryFields, actorId: string, prepared: Prepared & { kind: 'ok' },
): Promise<CommissionPaidBy | undefined> {
  if (!f.targetId) return undefined;
  if (prepared.payer) {
    return recordPayerTx(tx, f.targetId, actorId, prepared.payer, { userId: f.managerId, company: false });
  }
  if (prepared.cost && prepared.cost.payment === 'self' && prepared.cost.paid_by !== f.managerId) {
    await tx`UPDATE orders SET paid_by = ${f.managerId}::uuid WHERE id = ${f.targetId}`;
    const changes: AuditChange[] = [{ field: 'paid_by', from: prepared.cost.paid_by, to: f.managerId }];
    await nameHandoffByChange(tx, changes);
    await writeOrderEvent(tx, f.targetId, actorId, 'meta_changed', { changes });
  }
  return undefined;
}

const MISSING: Record<AccountingTargetType, string> = {
  po: 'purchase order not found', so: 'sell order not found', as: 'after-sales case not found',
};

accounting.post('/entries', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);
  const v = validateFields(body);
  if ('error' in v) return c.json({ error: v.error }, 400);
  const f = v.fields;
  const sql = getDb(c.env);
  // Read before the transaction: the lookup may reach the rate service.
  const fxRate = f.currency === 'USD' ? f.fxRate ?? (await latestCnyPerUsd(sql)).rate : null;

  type Outcome =
    | { kind: 'missing'; what: AccountingTargetType }
    | { kind: 'refused'; status: 400 | 409; error: string }
    | { kind: 'created'; id: string; paidBy: CommissionPaidBy | undefined };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const prepared = await prepareTargetTx(tx, f);
    if (prepared.kind === 'missing') return prepared;
    // Who may pay is judged against the PO, so after it is read and held.
    const refused = await payerAllowedTx(tx, f, prepared);
    if (refused) return { kind: 'refused', ...refused };
    const id = await nextHumanId(tx, 'AC', 'AC');
    await tx`
      INSERT INTO accounting_entries ${tx({
        id, direction: f.direction, kind: f.kind, amount: f.amount, currency: f.currency, fx_rate: fxRate,
        method: f.method, occurred_on: f.occurredOn, manager_id: f.managerId,
        ...targetColumns(f.kind, f.targetId),
        counterparty: f.counterparty, reference: f.reference, note: f.note, created_by: u.id, author_id: u.id,
      })}`;
    await writeEvent(tx, id, u.id, 'created', {
      direction: f.direction, kind: f.kind, amount: f.amount, currency: f.currency, targetId: f.targetId,
    });
    return { kind: 'created', id, paidBy: await syncPayerToPoTx(tx, f, u.id, prepared) };
  });
  if (outcome.kind === 'missing') return c.json({ error: MISSING[outcome.what] }, 404);
  if (outcome.kind === 'refused') return c.json({ error: outcome.error }, outcome.status);
  return c.json(
    outcome.paidBy === undefined ? { id: outcome.id } : { id: outcome.id, commissionPaidBy: outcome.paidBy },
    201,
  );
});

const EDITABLE = [
  'direction', 'kind', 'amount', 'currency', 'fxRate', 'method', 'occurredOn', 'managerId',
  'targetId', 'counterparty', 'reference', 'note',
] as const;

accounting.patch('/entries/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);
  if (!EDITABLE.some(k => body[k] !== undefined)) return c.json({ error: 'nothing to change' }, 400);
  const sql = getDb(c.env);

  // Unlocked first look: which POs the edit touches, and whether it turns the
  // entry into dollars without a rate.
  const pre = (await sql<{ order_id: string | null; currency: string }[]>`
    SELECT order_id, currency FROM accounting_entries WHERE id = ${id} LIMIT 1`)[0];
  if (!pre) return c.json({ error: 'Not found' }, 404);
  const looked = body.currency === 'USD' && pre.currency !== 'USD' && (body.fxRate === undefined || body.fxRate === null)
    ? (await latestCnyPerUsd(sql)).rate : null;
  const poIds = [...new Set([pre.order_id, typeof body.targetId === 'string' ? body.targetId : null])]
    .filter((x): x is string => !!x).sort();

  type Outcome =
    | { kind: 'notFound' } | { kind: 'voided' } | { kind: 'moved' } | { kind: 'bad'; error: string }
    | { kind: 'refused'; status: 400 | 409; error: string }
    | { kind: 'missing'; what: AccountingTargetType }
    | { kind: 'ok'; paidBy: CommissionPaidBy | undefined };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    // Orders before the entry: a PO delete holds its order and then reaches
    // the entry through the FK's SET NULL.
    if (poIds.length) await tx`SELECT 1 FROM orders WHERE id = ANY(${poIds}) ORDER BY id FOR NO KEY UPDATE`;
    const row = (await tx<EntryRow[]>`
      SELECT ${entryCols(tx)} FROM accounting_entries e ${entryJoins(tx)}
      WHERE e.id = ${id} LIMIT 1 FOR UPDATE OF e
    `)[0];
    if (!row) return { kind: 'notFound' };
    if (row.order_id !== pre.order_id) return { kind: 'moved' };
    if (row.voided_at) return { kind: 'voided' };
    const cur = shapeEntry(row);
    const was: Record<string, unknown> = {
      direction: cur.direction, kind: cur.kind, amount: cur.amount, currency: cur.currency, fxRate: cur.fxRate,
      method: cur.method, occurredOn: cur.occurredOn, managerId: cur.manager.id,
      targetId: cur.target?.id ?? null, counterparty: cur.counterparty, reference: cur.reference, note: cur.note,
    };
    const merged = { ...was };
    for (const k of EDITABLE) if (body[k] !== undefined) merged[k] = body[k];
    // A kind that names another sort of record drops the old link.
    if (body.kind !== undefined && body.targetId === undefined
      && KIND_TARGET[merged.kind as AccountingKind] !== KIND_TARGET[cur.kind]) {
      merged.targetId = null;
    }
    const v = validateFields(merged, { orphan: merged.kind === cur.kind && merged.targetId === was.targetId });
    if ('error' in v) return { kind: 'bad', error: v.error };
    const f = v.fields;
    // Dollars keep the rate they were booked at unless one is sent.
    const fxRate = f.currency === 'USD' ? f.fxRate ?? cur.fxRate ?? looked : null;
    if (f.currency === 'USD' && fxRate === null) return { kind: 'bad', error: 'a dollar entry needs its fxRate' };

    const next: Record<string, unknown> = { ...f, fxRate };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of EDITABLE) if (next[k] !== was[k]) changes[k] = { from: was[k], to: next[k] };
    if (Object.keys(changes).length === 0) return { kind: 'ok', paidBy: undefined };

    // The PO is read, held and judged only when the link or the payer moves,
    // not on every later edit of a note.
    const linkChanged = 'kind' in changes || 'targetId' in changes || 'direction' in changes;
    const payerChanged = 'managerId' in changes;
    const prepared = linkChanged || payerChanged ? await prepareTargetTx(tx, f) : NO_PO;
    if (prepared.kind === 'missing') return prepared;
    if (linkChanged || payerChanged) {
      const refused = await payerAllowedTx(tx, f, prepared);
      if (refused) return { kind: 'refused', ...refused };
    }
    // Anything but the note is what a sign-off signed: changing it makes this
    // a new version, written by the editor, that someone else signs again. It
    // also answers an open question — the fix is the answer.
    const covered = Object.keys(changes)
      .some(k => !(ACCOUNTING_UNREVIEWED_FIELDS as readonly string[]).includes(k));
    const clearsReview = covered && row.reviewed_at !== null;
    const answersQuery = covered && row.query_at !== null && row.answer_at === null;
    await tx`
      UPDATE accounting_entries SET ${tx({
        direction: f.direction, kind: f.kind, amount: f.amount, currency: f.currency, fx_rate: fxRate,
        method: f.method, occurred_on: f.occurredOn, manager_id: f.managerId,
        ...targetColumns(f.kind, f.targetId),
        counterparty: f.counterparty, reference: f.reference, note: f.note,
      })}, updated_at = NOW()
      ${covered ? tx`, author_id = ${u.id}, reviewed_by = NULL, reviewed_at = NULL` : tx``}
      ${clearsReview ? tx`, review_cleared_at = NOW()` : tx``}
      ${answersQuery ? tx`, answer_by = ${u.id}, answer_at = NOW()` : tx``}
      WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'edited', {
      changes,
      ...(clearsReview ? { clearedReview: { by: row.reviewed_by, at: row.reviewed_at } } : {}),
      ...(answersQuery ? { answeredQuery: true } : {}),
    });
    if (answersQuery && row.query_by && row.query_by !== u.id) {
      await notify(tx, {
        userId: row.query_by, kind: 'accounting_answered', icon: 'cash',
        title: `${u.name} changed ${id} after your question`,
        body: Object.keys(changes).join(', '),
      });
    }
    const paidBy = linkChanged || payerChanged ? await syncPayerToPoTx(tx, f, u.id, prepared) : undefined;
    return { kind: 'ok', paidBy };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'voided': return c.json({ error: 'a voided entry is read-only — restore it first' }, 409);
    case 'moved': return c.json({ error: 'the entry changed while saving — open it again' }, 409);
    case 'bad': return c.json({ error: outcome.error }, 400);
    case 'refused': return c.json({ error: outcome.error }, outcome.status);
    case 'missing': return c.json({ error: MISSING[outcome.what] }, 404);
    case 'ok': return c.json(outcome.paidBy === undefined ? { ok: true } : { ok: true, commissionPaidBy: outcome.paidBy });
  }
});

// Voiding keeps the entry and its history; it only leaves the totals.
accounting.post('/entries/:id/void', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = optText(body?.reason, MAX_NOTE);
  if (!reason) return c.json({ error: 'a reason is required' }, 400);
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx) => {
    const cur = (await tx<{ voided_at: string | null }[]>`
      SELECT voided_at FROM accounting_entries WHERE id = ${id} LIMIT 1 FOR UPDATE`)[0];
    if (!cur) return 'notFound' as const;
    if (cur.voided_at) return 'already' as const;
    await tx`
      UPDATE accounting_entries
      SET voided_at = NOW(), voided_by = ${u.id}, void_reason = ${reason}, updated_at = NOW()
      WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'voided', { reason });
    return 'ok' as const;
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome === 'already') return c.json({ error: 'this entry is already voided' }, 409);
  return c.json({ ok: true });
});

accounting.post('/entries/:id/restore', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx) => {
    const cur = (await tx<{
      voided_at: string | null; void_reason: string | null; reviewed_by: string | null; reviewed_at: string | null;
    }[]>`
      SELECT voided_at, void_reason, reviewed_by, reviewed_at
      FROM accounting_entries WHERE id = ${id} LIMIT 1 FOR UPDATE`)[0];
    if (!cur) return 'notFound' as const;
    if (!cur.voided_at) return 'live' as const;
    // Putting money back on the book is a decision of its own, so the entry
    // comes back To review, whatever was signed or asked before the void.
    await tx`
      UPDATE accounting_entries
      SET voided_at = NULL, voided_by = NULL, void_reason = NULL, updated_at = NOW(),
          reviewed_by = NULL, reviewed_at = NULL, review_cleared_at = NULL,
          query_by = NULL, query_text = NULL, query_at = NULL,
          answer_by = NULL, answer_text = NULL, answer_at = NULL
      WHERE id = ${id}`;
    // The last word: a PO the Business Account paid voids its entries, and
    // this event is what keeps it from voiding this one again (0199).
    await writeEvent(tx, id, u.id, 'restored', {
      reason: cur.void_reason,
      ...(cur.reviewed_at ? { clearedReview: { by: cur.reviewed_by, at: cur.reviewed_at } } : {}),
    });
    return 'ok' as const;
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome === 'live') return c.json({ error: 'this entry is not voided' }, 409);
  return c.json({ ok: true });
});

// ── Review ──────────────────────────────────────────────────────────────────
// One manager who didn't write an entry signs it off (0197). The rules live
// here, so every shell keeps them: the author can't sign off their own
// version, a page that is out of date can't sign off a version it never
// showed, and an edit to anything but the note clears the sign-off (PATCH).

const REVIEW_LIST_MAX = 500;

async function lockEntryTx(tx: SqlLike, id: string): Promise<EntryRow | null> {
  return (await tx<EntryRow[]>`
    SELECT ${entryCols(tx)} FROM accounting_entries e ${entryJoins(tx)}
    WHERE e.id = ${id} LIMIT 1 FOR UPDATE OF e`)[0] ?? null;
}

type Refusal = { status: 403 | 409; error: string; code?: 'changed' };

function signOffRefusal(row: EntryRow, me: string, version: string): Refusal | null {
  if (row.voided_at) return { status: 409, error: 'a voided entry is out of review — restore it first' };
  if (row.reviewed_at) return { status: 409, error: `${row.reviewed_by_name ?? 'another manager'} already reviewed this entry` };
  if (row.author_id === me) return { status: 403, error: 'you wrote this version — another manager reviews it' };
  if (row.version !== version) return { status: 409, error: 'the entry changed since you opened it', code: 'changed' };
  return null;
}

async function signOffTx(tx: SqlLike, row: EntryRow, me: string) {
  const closesQuery = row.query_at !== null && row.answer_at === null;
  // updated_at stays: a sign-off says something about the entry, it doesn't
  // make a new version of it.
  await tx`
    UPDATE accounting_entries
    SET reviewed_by = ${me}, reviewed_at = NOW(), review_cleared_at = NULL,
        query_by = NULL, query_text = NULL, query_at = NULL,
        answer_by = NULL, answer_text = NULL, answer_at = NULL
    WHERE id = ${row.id}`;
  await writeEvent(tx, row.id, me, 'reviewed', {
    amountCny: row.amount_cny, ...(closesQuery ? { closedQuery: true } : {}),
  });
}

const refuse = (c: { json: (b: unknown, s: 403 | 409) => Response }, r: Refusal) =>
  c.json(r.code ? { error: r.error, code: r.code } : { error: r.error }, r.status);

accounting.post('/entries/:id/review', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
  if (typeof body?.version !== 'string') return c.json({ error: 'version is required' }, 400);
  const version = body.version;
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx): Promise<'notFound' | 'ok' | Refusal> => {
    const row = await lockEntryTx(tx, id);
    if (!row) return 'notFound';
    const refused = signOffRefusal(row, u.id, version);
    if (refused) return refused;
    await signOffTx(tx, row, u.id);
    return 'ok';
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome !== 'ok') return refuse(c, outcome);
  return c.json({ ok: true });
});

accounting.delete('/entries/:id/review', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx): Promise<'notFound' | 'ok' | Refusal> => {
    const row = await lockEntryTx(tx, id);
    if (!row) return 'notFound';
    if (row.voided_at || !row.reviewed_at) return { status: 409, error: 'this entry is not reviewed' };
    if (row.reviewed_by !== u.id) return { status: 403, error: 'only the manager who reviewed it can withdraw the review' };
    await tx`UPDATE accounting_entries SET reviewed_by = NULL, reviewed_at = NULL WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'unreviewed');
    return 'ok';
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome !== 'ok') return refuse(c, outcome);
  return c.json({ ok: true });
});

const queryText = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= ACCOUNTING_QUERY_MAX ? t : null;
};

accounting.post('/entries/:id/query', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = queryText(body?.text);
  if (!text) return c.json({ error: `a question takes 1 to ${ACCOUNTING_QUERY_MAX} characters` }, 400);
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx): Promise<'notFound' | 'ok' | Refusal | { status: 400; error: string }> => {
    const row = await lockEntryTx(tx, id);
    if (!row) return 'notFound';
    if (row.voided_at) return { status: 409, error: 'a voided entry is out of review — restore it first' };
    if (row.reviewed_at) return { status: 409, error: 'this entry is already reviewed' };
    if (row.query_at && !row.answer_at) return { status: 409, error: 'this entry already has an open question' };
    if (row.author_id === u.id) return { status: 403, error: 'you wrote this version — another manager reviews it' };
    const to = addresseeOf(row);
    if (to === u.id) return { status: 400, error: 'this entry is yours to correct — edit it instead' };
    await tx`
      UPDATE accounting_entries
      SET query_by = ${u.id}, query_text = ${text}, query_at = NOW(),
          answer_by = NULL, answer_text = NULL, answer_at = NULL
      WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'queried', { text });
    await notify(tx, { userId: to, kind: 'accounting_query', icon: 'cash', title: `${u.name} asked about ${id}`, body: text });
    return 'ok';
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome !== 'ok') return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true });
});

accounting.delete('/entries/:id/query', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx): Promise<'notFound' | 'ok' | Refusal> => {
    const row = await lockEntryTx(tx, id);
    if (!row) return 'notFound';
    if (!row.query_at || row.answer_at || row.reviewed_at) return { status: 409, error: 'this entry has no open question' };
    if (row.query_by !== u.id) return { status: 403, error: 'only the manager who asked can withdraw the question' };
    await tx`
      UPDATE accounting_entries
      SET query_by = NULL, query_text = NULL, query_at = NULL,
          answer_by = NULL, answer_text = NULL, answer_at = NULL
      WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'query_withdrawn');
    return 'ok';
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome !== 'ok') return refuse(c, outcome);
  return c.json({ ok: true });
});

accounting.post('/entries/:id/answer', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = queryText(body?.text);
  if (!text) return c.json({ error: `an answer takes 1 to ${ACCOUNTING_QUERY_MAX} characters` }, 400);
  const sql = getDb(c.env);
  const outcome = await sql.begin(async (tx): Promise<'notFound' | 'ok' | Refusal> => {
    const row = await lockEntryTx(tx, id);
    if (!row) return 'notFound';
    if (row.voided_at || !row.query_at || row.answer_at || row.reviewed_at) {
      return { status: 409, error: 'this entry has no open question' };
    }
    if (addresseeOf(row) !== u.id) return { status: 403, error: 'the question is for the manager who wrote the entry' };
    await tx`UPDATE accounting_entries SET answer_by = ${u.id}, answer_text = ${text}, answer_at = NOW() WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'answered', { text });
    if (row.query_by) {
      await notify(tx, { userId: row.query_by, kind: 'accounting_answered', icon: 'cash', title: `${u.name} answered about ${id}`, body: text });
    }
    return 'ok';
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome !== 'ok') return refuse(c, outcome);
  return c.json({ ok: true });
});

// What a reviewer weighs an entry against: the FX ledger's rate on its day
// (the earliest rate for a day before the ledger begins), another live entry
// that looks like the same money, and every edit since a sign-off was cleared.
function reviewFactCols(sql: SqlLike) {
  return sql`
    COALESCE(
      (SELECT r.rate::float FROM fx_rates r
        WHERE r.base_currency = 'USD' AND r.quote_currency = 'CNY' AND r.effective_date <= e.occurred_on
        ORDER BY r.effective_date DESC, r.fetched_at DESC LIMIT 1),
      (SELECT r.rate::float FROM fx_rates r
        WHERE r.base_currency = 'USD' AND r.quote_currency = 'CNY'
        ORDER BY r.effective_date, r.fetched_at LIMIT 1)) AS ledger_rate,
    (SELECT d.id FROM accounting_entries d
      WHERE d.id <> e.id AND d.voided_at IS NULL AND d.direction = e.direction AND d.kind = e.kind
        AND d.amount = e.amount AND d.currency = e.currency AND d.method = e.method
        AND abs(d.occurred_on - e.occurred_on) <= ${ACCOUNTING_DUPLICATE_DAYS}
        AND (d.order_id = e.order_id OR d.sell_order_id = e.sell_order_id OR d.after_sales_id = e.after_sales_id
             OR (e.kind = 'other' AND e.counterparty IS NOT NULL AND lower(d.counterparty) = lower(e.counterparty)))
      ORDER BY abs(d.occurred_on - e.occurred_on), d.id LIMIT 1) AS duplicate_of,
    (SELECT json_agg(json_build_object(
              'changes', ev.detail->'changes', 'by', ev.detail->'clearedReview'->>'by', 'at', ev.created_at,
              'synced', ev.detail->>'synced')
            ORDER BY ev.created_at, ev.id)
       FROM accounting_entry_events ev
      WHERE ev.entry_id = e.id AND ev.kind = 'edited' AND e.review_cleared_at IS NOT NULL
        AND ev.created_at >= e.review_cleared_at) AS edits
  `;
}

type FactRow = EntryRow & {
  ledger_rate: number | null; duplicate_of: string | null;
  edits: {
    changes: Record<string, { from: unknown; to: unknown }> | null; by: string | null; at: string; synced: string | null;
  }[] | null;
};

// Every field changed since the sign-off was cleared, from what the reviewer
// signed to what the entry says now. A field put back as it was drops out.
function sinceReview(edits: NonNullable<FactRow['edits']>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const ev of edits) {
    for (const [k, ch] of Object.entries(ev.changes ?? {})) {
      out[k] = { from: k in out ? out[k].from : ch.from, to: ch.to };
    }
  }
  for (const k of Object.keys(out)) if (JSON.stringify(out[k].from) === JSON.stringify(out[k].to)) delete out[k];
  return out;
}

async function withFacts(sql: SqlLike, rows: FactRow[]) {
  const ids: Record<TargetLens, Set<string>> = { purchase: new Set(), commission: new Set(), so: new Set(), as: new Set() };
  for (const r of rows) {
    const t = targetOf(r);
    if (t && r.kind !== 'other') ids[LENS_OF[r.kind]].add(t.id);
  }
  const lenses = Object.keys(ids) as TargetLens[];
  const found = await allLimited(lenses.map(l => () => findTargets(sql, l, { ids: [...ids[l]] })));
  const byLens = new Map(lenses.map((l, i) => [l, new Map(found[i].map(t => [t.id, t]))]));
  const reviewers = new Set(rows.flatMap(r => (r.edits?.[0]?.by ? [r.edits[0].by] : [])));
  const names = reviewers.size
    ? new Map((await sql<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE id = ANY(${[...reviewers]})`)
      .map(u => [u.id, u.name]))
    : new Map<string, string>();
  return rows.map(r => {
    const t = targetOf(r);
    const target = t && r.kind !== 'other' ? byLens.get(LENS_OF[r.kind])?.get(t.id) ?? null : null;
    const facts: AccountingReviewFacts = {
      record: target ? { amount: target.amount, currency: target.currency, recordedCny: target.recordedCny } : null,
      ledgerRate: r.ledger_rate,
      duplicateOf: r.duplicate_of,
    };
    const first = r.edits?.[0];
    return {
      ...shapeEntry(r),
      target: t,
      targetFacts: target,
      facts,
      checks: accountingChecks({ kind: r.kind, currency: r.currency, fxRate: r.fx_rate, hasTarget: !!t }, facts),
      cleared: r.review_cleared_at && r.edits?.length ? {
        reviewer: first?.by ? { id: first.by, name: names.get(first.by) ?? '' } : null,
        at: r.review_cleared_at,
        changes: sinceReview(r.edits),
        // The last change came from the PO's side, so nobody wrote it: the
        // row says so rather than naming the author, who didn't.
        followedPo: r.edits.at(-1)?.synced === 'po',
      } : null,
    };
  });
}

function reviewTabFrag(sql: SqlLike, tab: AccountingReviewTab, me: string) {
  const state = reviewStateSql(sql);
  switch (tab) {
    case 'mine': return sql`${state} IN ('open', 'changed') AND e.author_id IS DISTINCT FROM ${me}`;
    case 'queried': return sql`${state} = 'queried'`;
    case 'others': return sql`${state} IN ('open', 'changed') AND e.author_id = ${me}`;
    case 'reviewed': return sql`e.reviewed_at >= NOW() - INTERVAL '30 days'`;
  }
}

// Review mode's lists. Not scoped by the book's period: a backlog must not
// hide behind This month. Oldest first, the way a queue is cleared.
accounting.get('/review', async (c) => {
  const me = c.var.user.id;
  const tabRaw = c.req.query('tab') ?? 'mine';
  if (!(ACCOUNTING_REVIEW_TABS as readonly string[]).includes(tabRaw)) return c.json({ error: 'unknown tab' }, 400);
  const tab = tabRaw as AccountingReviewTab;
  const managerId = parseManager(c.req.query('managerId'));
  if (managerId === undefined) return c.json({ error: 'invalid managerId' }, 400);
  const sql = getDb(c.env);
  const mgr = managerId ? sql`e.manager_id = ${managerId}` : sql`TRUE`;
  const [rows, counts] = await allLimited([
    () => sql<FactRow[]>`
      SELECT ${entryCols(sql)}, ${reviewFactCols(sql)}
      FROM accounting_entries e ${entryJoins(sql)}
      WHERE e.voided_at IS NULL AND ${mgr} AND ${reviewTabFrag(sql, tab, me)}
      ORDER BY ${tab === 'reviewed' ? sql`e.reviewed_at DESC, e.id DESC` : sql`e.occurred_on, e.created_at, e.id`}
      LIMIT ${REVIEW_LIST_MAX}`,
    () => sql<Record<AccountingReviewTab, number>[]>`
      SELECT COUNT(*) FILTER (WHERE ${reviewTabFrag(sql, 'mine', me)})::int AS mine,
             COUNT(*) FILTER (WHERE ${reviewTabFrag(sql, 'queried', me)})::int AS queried,
             COUNT(*) FILTER (WHERE ${reviewTabFrag(sql, 'others', me)})::int AS others,
             COUNT(*) FILTER (WHERE ${reviewTabFrag(sql, 'reviewed', me)})::int AS reviewed
      FROM accounting_entries e WHERE e.voided_at IS NULL AND ${mgr}`,
  ]);
  return c.json({
    rows: await withFacts(sql, rows),
    counts: counts[0],
    truncated: rows.length === REVIEW_LIST_MAX,
  });
});

// The sidebar's badge: what waits on the viewer, sign-offs and questions both.
accounting.get('/review/count', async (c) => {
  const me = c.var.user.id;
  const sql = getDb(c.env);
  const state = reviewStateSql(sql);
  const [r] = await sql<{ for_me: number; asked: number }[]>`
    SELECT COUNT(*) FILTER (WHERE ${state} IN ('open', 'changed') AND e.author_id IS DISTINCT FROM ${me})::int AS for_me,
           COUNT(*) FILTER (WHERE ${state} = 'queried' AND COALESCE(e.author_id, e.manager_id) = ${me})::int AS asked
    FROM accounting_entries e WHERE e.voided_at IS NULL AND e.reviewed_at IS NULL`;
  return c.json({ forMe: r.for_me, asked: r.asked });
});

const BULK_MAX = 200;

// Signs off a batch the page listed. Only a plain To review entry with no
// warning goes through; anything else is reported back, never forced.
accounting.post('/review/bulk', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as { entries?: unknown } | null;
  const list = Array.isArray(body?.entries) ? body.entries : null;
  if (!list || list.length === 0 || list.length > BULK_MAX
    || !list.every(x => typeof x?.id === 'string' && typeof x?.version === 'string')) {
    return c.json({ error: `entries takes 1 to ${BULK_MAX} { id, version } pairs` }, 400);
  }
  const wanted = new Map((list as { id: string; version: string }[]).map(x => [x.id, x.version]));
  const sql = getDb(c.env);
  // The checks are read before the locks: a change in between moves the
  // version, which the sign-off below refuses.
  const factRows = await sql<FactRow[]>`
    SELECT ${entryCols(sql)}, ${reviewFactCols(sql)}
    FROM accounting_entries e ${entryJoins(sql)} WHERE e.id = ANY(${[...wanted.keys()]})`;
  const warned = new Set((await withFacts(sql, factRows)).filter(r => hasAccountingWarning(r.checks)).map(r => r.id));

  const skipped: { id: string; reason: string }[] = [];
  const reviewed: string[] = [];
  await sql.begin(async (tx) => {
    // One lock order, by id, so two bulk sign-offs can't deadlock each other.
    const locked = await tx<EntryRow[]>`
      SELECT ${entryCols(tx)} FROM accounting_entries e ${entryJoins(tx)}
      WHERE e.id = ANY(${[...wanted.keys()]}) ORDER BY e.id FOR UPDATE OF e`;
    const byId = new Map(locked.map(r => [r.id, r]));
    for (const [id, version] of wanted) {
      const row = byId.get(id);
      if (!row) { skipped.push({ id, reason: 'not found' }); continue; }
      const refused = signOffRefusal(row, u.id, version);
      if (refused) { skipped.push({ id, reason: refused.error }); continue; }
      if (reviewStateOf(row) !== 'open') { skipped.push({ id, reason: 'changed or queried entries are reviewed one by one' }); continue; }
      if (warned.has(id)) { skipped.push({ id, reason: 'it has a warning' }); continue; }
      await signOffTx(tx, row, u.id);
      reviewed.push(id);
    }
  });
  return c.json({ reviewed, skipped });
});

// ── Records an entry can be for ─────────────────────────────────────────────

accounting.get('/targets', async (c) => {
  const kind = c.req.query('kind');
  if (!isAccountingKind(kind) || kind === 'other') return c.json({ error: 'kind must name a record' }, 400);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const sql = getDb(c.env);
  return c.json({ candidates: await findTargets(sql, LENS_OF[kind], { q: q || undefined }) });
});

// One record's side of the book: its live entries, what they come to, and
// the record's own figure with its RMB equivalent at today's rate.
async function ledgerFor(sql: SqlLike, lens: TargetLens, id: string, entriesWhere: Frag) {
  const [rows, target, fx] = await allLimited([
    () => sql<EntryRow[]>`
      SELECT ${entryCols(sql)} FROM accounting_entries e ${entryJoins(sql)}
      WHERE e.voided_at IS NULL AND ${entriesWhere}
      ORDER BY e.occurred_on DESC, e.created_at DESC, e.id DESC`,
    () => findTargets(sql, lens, { id }),
    () => latestCnyPerUsd(sql),
  ]);
  const t = target[0];
  if (!t) return null;
  return {
    entries: rows.map(shapeEntry),
    net: t.recordedCny,
    target: {
      ...t,
      amountCny: t.amount === null ? null
        : t.currency === 'CNY' ? t.amount : Math.round(t.amount * fx.rate * 100) / 100,
    },
    fx,
  };
}

accounting.get('/by-order/:id', async (c) => {
  const kind = c.req.query('kind');
  if (kind !== 'purchase' && kind !== 'commission') return c.json({ error: 'kind must be purchase or commission' }, 400);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const out = await ledgerFor(sql, kind, id, sql`e.order_id = ${id} AND e.kind = ${kind}`);
  return out ? c.json(out) : c.json({ error: 'Not found' }, 404);
});

accounting.get('/by-sell-order/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const out = await ledgerFor(sql, 'so', id, sql`(e.sell_order_id = ${id}
    OR e.after_sales_id IN (SELECT ac.id FROM after_sales_cases ac WHERE ac.sell_order_id = ${id}))`);
  return out ? c.json(out) : c.json({ error: 'Not found' }, 404);
});

accounting.get('/by-after-sales/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const out = await ledgerFor(sql, 'as', id, sql`e.after_sales_id = ${id}`);
  return out ? c.json(out) : c.json({ error: 'Not found' }, 404);
});

export default accounting;
