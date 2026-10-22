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
import { authMiddleware } from '../auth';
import { requireManager } from '../lib/role';
import { lockPayerTx, recordPayerTx, type CommissionPaidBy, type PayerRow } from './orders/shared';
import type { Env, User } from '../types';
import {
  ACCOUNTING_KINDS, KIND_TARGET, addDays, isAccountingCurrency, isAccountingDirection, isAccountingKind,
  isAccountingMethod, isIsoDate, todayIn,
  type AccountingCurrency, type AccountingDirection, type AccountingKind, type AccountingMethod,
  type AccountingTargetType,
} from '@recycle-erp/shared';

// Accounting: the managers' own book of money received and paid, in RMB.
// An entry is a record of money that moved — it changes nothing on the PO,
// sell order or case it names, with one exception: a commission a manager
// paid fills the PO's "Commission paid by" when nobody is on file, by the
// same rule the commission screenshot upload follows.
const accounting = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

// A mistyped amount or rate is refused here rather than overflowing amount_cny.
const MAX_AMOUNT = 1_000_000_000;
const MAX_RATE = 100;
const MAX_SHORT = 200;
const MAX_NOTE = 2000;
const EARLIEST = '2000-01-01';

type EventKind = 'created' | 'edited' | 'voided' | 'restored' | 'unlinked';
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
};

function entryCols(sql: SqlLike) {
  return sql`
    e.id, e.direction, e.kind, e.amount::float AS amount, e.currency, e.fx_rate::float AS fx_rate,
    e.amount_cny::float AS amount_cny, e.method, to_char(e.occurred_on, 'YYYY-MM-DD') AS occurred_on,
    e.manager_id, m.name AS manager_name, e.order_id, e.sell_order_id, e.after_sales_id,
    e.counterparty, e.reference, e.note, e.created_at, e.updated_at,
    e.created_by, cb.name AS created_by_name, e.voided_at, e.void_reason, vb.name AS voided_by_name
  `;
}

function entryJoins(sql: SqlLike) {
  return sql`
    JOIN users m ON m.id = e.manager_id
    LEFT JOIN users cb ON cb.id = e.created_by
    LEFT JOIN users vb ON vb.id = e.voided_by
  `;
}

function targetOf(r: { order_id: string | null; sell_order_id: string | null; after_sales_id: string | null }) {
  if (r.order_id) return { type: 'po' as const, id: r.order_id };
  if (r.sell_order_id) return { type: 'so' as const, id: r.sell_order_id };
  if (r.after_sales_id) return { type: 'as' as const, id: r.after_sales_id };
  return null;
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
  sql: SqlLike, lens: TargetLens, opts: { id?: string; q?: string },
): Promise<TargetFacts[]> {
  const like = opts.q ? `%${escapeLike(opts.q)}%` : null;
  if (lens === 'purchase' || lens === 'commission') {
    const scope = opts.id ? sql`o.id = ${opts.id}`
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
    }[]>`
      SELECT o.id, o.lifecycle AS status,
             ${lens === 'commission' ? sql`u.name` : sql`COALESCE(sup.name, u.name)`} AS party,
             ${amount} AS amount, ${recordedFrag(sql, lens, sql`o.id`)} AS recorded,
             ${payerCol} AS payer_id, pb.name AS payer_name, ${business} AS payer_business
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN users pb ON pb.id = ${payerCol}
      LEFT JOIN suppliers sup ON sup.id = o.supplier_id
      ${poRealizedLateral(sql, lens === 'commission')}
      WHERE ${scope}
      ORDER BY o.created_at DESC
      LIMIT 10`;
    return rows.map(({ payer_id, payer_name, payer_business, ...r }) => ({
      ...r, currency: 'USD' as const, recordedCny: r.recorded,
      payerId: payer_business ? null : payer_id,
      payerName: payer_business ? null : payer_name,
      payerBusiness: payer_business,
    }));
  }
  if (lens === 'so') {
    const scope = opts.id ? sql`so.id = ${opts.id}`
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
      LIMIT 10`;
    return rows.map(r => ({ ...r, recordedCny: r.recorded }));
  }
  const scope = opts.id ? sql`c.id = ${opts.id}`
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
    LIMIT 10`;
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

// The period as the book states it: what was brought in, what came and went,
// and what was carried out — opening + received − paid = closing — plus each
// manager's own balance on the closing date.
accounting.get('/summary', async (c) => {
  const win = parseWindow(c.req.query('from'), c.req.query('to'));
  if (!win) return c.json({ error: 'from and to must be dates, from on or before to' }, 400);
  const managerId = parseManager(c.req.query('managerId'));
  if (managerId === undefined) return c.json({ error: 'invalid managerId' }, 400);
  const sql = getDb(c.env);
  const mgr = managerId ? sql`AND e.manager_id = ${managerId}` : sql`AND TRUE`;
  const live = sql`e.voided_at IS NULL AND e.occurred_on <= ${win.to}::date ${mgr}`;
  const inWindow = sql`e.occurred_on >= ${win.from}::date`;

  const [totals, byKind, managers, first, fx] = await allLimited([
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
  ]);

  const kinds = Object.fromEntries(ACCOUNTING_KINDS.map(k => [k, { received: 0, paid: 0, count: 0 }]));
  for (const r of byKind) kinds[r.kind] = { received: r.received, paid: r.paid, count: r.count };
  return c.json({
    from: win.from, to: win.to,
    ...totals[0],
    byKind: kinds,
    managers,
    first: first[0]?.first ?? null,
    fx,
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
    q('voided') === '1' ? null : sql`e.voided_at IS NULL`,
    search ? sql`(e.id ILIKE ${like} OR e.counterparty ILIKE ${like} OR e.reference ILIKE ${like}
                  OR e.note ILIKE ${like} OR e.order_id ILIKE ${like} OR e.sell_order_id ILIKE ${like}
                  OR e.after_sales_id ILIKE ${like})` : null,
    cursor ? sql`(e.occurred_on, e.created_at, e.id)
                 < (${cursor.day}::date, ${cursorTsParam(sql, cursor.ts)}, ${cursor.id})` : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);
  const where = frags.reduce((acc, f) => sql`${acc} AND ${f}`, sql`TRUE`);

  // The balance runs over the manager's whole book before any filter, so
  // hiding rows never changes what a row says is left after it.
  const rows = await sql<(EntryRow & { balance: number | null; cursor_ts: string })[]>`
    WITH book AS (
      SELECT e.id,
             SUM(${signedCny(sql)}) FILTER (WHERE e.voided_at IS NULL)
               OVER (ORDER BY e.occurred_on, e.created_at, e.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
      FROM accounting_entries e
      WHERE ${managerId ? sql`e.manager_id = ${managerId}` : sql`TRUE`}
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

type Prepared =
  | { kind: 'missing'; what: AccountingTargetType }
  | { kind: 'ok'; payer: PayerRow | null };

// Confirms the record exists and holds it until commit, so a delete can't
// slip between the check and the insert's FK. A paid commission locks its PO
// for the payer fill instead — the orders row is the one lock taken first.
async function prepareTargetTx(tx: SqlLike, f: EntryFields): Promise<Prepared> {
  const type = KIND_TARGET[f.kind];
  if (!type || !f.targetId) return { kind: 'ok', payer: null };
  if (f.kind === 'commission' && f.direction === 'out') {
    const payer = await lockPayerTx(tx, f.targetId);
    return payer ? { kind: 'ok', payer } : { kind: 'missing', what: 'po' };
  }
  const table = type === 'po' ? tx`orders` : type === 'so' ? tx`sell_orders` : tx`after_sales_cases`;
  const found = await tx`SELECT 1 FROM ${table} WHERE id = ${f.targetId} LIMIT 1 FOR KEY SHARE`;
  return found.length ? { kind: 'ok', payer: null } : { kind: 'missing', what: type };
}

// The commission screenshot's rule (routes/orders/evidence.ts): nobody on
// file, not the company, and no bank row standing as the commission. Returns
// the new payer only when it wrote one.
async function fillPayerTx(
  tx: SqlLike, f: EntryFields, actorId: string, payer: PayerRow | null,
): Promise<CommissionPaidBy | undefined> {
  if (!payer || !f.targetId) return undefined;
  if (payer.commission_paid_by !== null || payer.commission_paid_by_company || payer.commission_linked) return undefined;
  return recordPayerTx(tx, f.targetId, actorId, payer, { userId: f.managerId, company: false });
}

// A corrected manager carries the payer along only while the PO still names
// the entry's old manager — the payer that entry filled. One set by hand,
// cleared on purpose, the company or a bank row stays as it is.
async function movePayerTx(
  tx: SqlLike, f: EntryFields, fromManagerId: string, actorId: string, payer: PayerRow | null,
): Promise<CommissionPaidBy | undefined> {
  if (!payer || !f.targetId) return undefined;
  if (payer.commission_paid_by !== fromManagerId || payer.commission_paid_by_company || payer.commission_linked) return undefined;
  return recordPayerTx(tx, f.targetId, actorId, payer, { userId: f.managerId, company: false });
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
  if (!(await isActiveManager(sql, f.managerId))) return c.json({ error: 'managerId must be an active manager' }, 400);
  // Read before the transaction: the lookup may reach the rate service.
  const fxRate = f.currency === 'USD' ? f.fxRate ?? (await latestCnyPerUsd(sql)).rate : null;

  type Outcome =
    | { kind: 'missing'; what: AccountingTargetType }
    | { kind: 'created'; id: string; paidBy: CommissionPaidBy | undefined };
  const outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const prepared = await prepareTargetTx(tx, f);
    if (prepared.kind === 'missing') return prepared;
    const id = await nextHumanId(tx, 'AC', 'AC');
    await tx`
      INSERT INTO accounting_entries ${tx({
        id, direction: f.direction, kind: f.kind, amount: f.amount, currency: f.currency, fx_rate: fxRate,
        method: f.method, occurred_on: f.occurredOn, manager_id: f.managerId,
        ...targetColumns(f.kind, f.targetId),
        counterparty: f.counterparty, reference: f.reference, note: f.note, created_by: u.id,
      })}`;
    await writeEvent(tx, id, u.id, 'created', {
      direction: f.direction, kind: f.kind, amount: f.amount, currency: f.currency, targetId: f.targetId,
    });
    return { kind: 'created', id, paidBy: await fillPayerTx(tx, f, u.id, prepared.payer) };
  });
  if (outcome.kind === 'missing') return c.json({ error: MISSING[outcome.what] }, 404);
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
    if (f.managerId !== cur.manager.id && !(await isActiveManager(tx, f.managerId))) {
      return { kind: 'bad', error: 'managerId must be an active manager' };
    }

    const next: Record<string, unknown> = { ...f, fxRate };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of EDITABLE) if (next[k] !== was[k]) changes[k] = { from: was[k], to: next[k] };
    if (Object.keys(changes).length === 0) return { kind: 'ok', paidBy: undefined };

    // The payer is filled as the screenshot's is, once: when the entry comes
    // to pay this PO's commission, not on every later edit of its note.
    const linkChanged = 'kind' in changes || 'targetId' in changes || 'direction' in changes;
    const managerChanged = 'managerId' in changes && f.kind === 'commission';
    const prepared = linkChanged || managerChanged
      ? await prepareTargetTx(tx, f) : { kind: 'ok' as const, payer: null };
    if (prepared.kind === 'missing') return prepared;
    await tx`
      UPDATE accounting_entries SET ${tx({
        direction: f.direction, kind: f.kind, amount: f.amount, currency: f.currency, fx_rate: fxRate,
        method: f.method, occurred_on: f.occurredOn, manager_id: f.managerId,
        ...targetColumns(f.kind, f.targetId),
        counterparty: f.counterparty, reference: f.reference, note: f.note,
      })}, updated_at = NOW()
      WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'edited', { changes });
    const paidBy = linkChanged ? await fillPayerTx(tx, f, u.id, prepared.payer)
      : managerChanged ? await movePayerTx(tx, f, cur.manager.id, u.id, prepared.payer)
      : undefined;
    return { kind: 'ok', paidBy };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'voided': return c.json({ error: 'a voided entry is read-only — restore it first' }, 409);
    case 'moved': return c.json({ error: 'the entry changed while saving — open it again' }, 409);
    case 'bad': return c.json({ error: outcome.error }, 400);
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
    const cur = (await tx<{ voided_at: string | null; void_reason: string | null }[]>`
      SELECT voided_at, void_reason FROM accounting_entries WHERE id = ${id} LIMIT 1 FOR UPDATE`)[0];
    if (!cur) return 'notFound' as const;
    if (!cur.voided_at) return 'live' as const;
    await tx`
      UPDATE accounting_entries
      SET voided_at = NULL, voided_by = NULL, void_reason = NULL, updated_at = NOW()
      WHERE id = ${id}`;
    await writeEvent(tx, id, u.id, 'restored', { reason: cur.void_reason });
    return 'ok' as const;
  });
  if (outcome === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome === 'live') return c.json({ error: 'this entry is not voided' }, 409);
  return c.json({ ok: true });
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
