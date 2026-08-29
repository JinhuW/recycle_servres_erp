// Clients — the people we buy from. "Suppliers" in the schema, "Clients" in the
// UI (客户 is already the sell-side customers, so the two would collide in
// Chinese).
//
// Reads are owner-scoped: a purchaser works their own book, a manager sees
// everyone's. That is not decoration — seller addresses arrive from shipments,
// which are already scoped to the ordering purchaser, so a shared book would
// widen who can read them.
//
// Tier, health and the follow-up date are computed per read from purchase-order
// history (services/supplierCrm.ts). Nothing here caches or stores them.

import { Hono } from 'hono';
import { getDb } from '../db';
import { clampLimit } from '../lib/pagination';
import { effectiveRole } from '../lib/role';
import type { Env, User } from '../types';
import {
  loadCrmSettings, tierFor, cadenceFor, healthFor, effectiveGap, dueStateFor,
  isoDatePlus, type CrmSettings, type Tier,
} from '../services/supplierCrm';

const suppliers = new Hono<{ Bindings: Env; Variables: { user: User } }>();

/** Recency-weighted trailing-12-month spend. Money from last month says more
 *  about a live relationship than money from ten months ago, so a client who
 *  has quietly stopped trading drifts down the priority list on their own. */
const SCORE_SQL = `COALESCE(SUM(o.total_cost * CASE
  WHEN o.created_at > NOW() - INTERVAL '90 days'  THEN 1.0
  WHEN o.created_at > NOW() - INTERVAL '180 days' THEN 0.6
  WHEN o.created_at > NOW() - INTERVAL '365 days' THEN 0.3
  ELSE 0 END), 0)::float`;

/** The compressed-name expression suppliers.match_key is generated from. Kept
 *  as SQL text, never re-implemented in TypeScript — see the note in 0112. */
const COMPRESS = (col: string) => `regexp_replace(upper(${col}), '[^A-Z0-9]', '', 'g')`;

type Row = {
  id: string; name: string; company: string | null; phone: string | null; email: string | null;
  street1: string | null; street2: string | null; city: string | null; state: string | null;
  zip: string | null; country: string; owner_id: string | null; owner_name: string | null;
  source: string; status: 'prospect' | 'active' | 'archived'; supplies: string[];
  pref_payment: string | null; pref_logistics: string | null; pref_contact: string | null;
  pref_best_time: string | null; pref_price: string | null; notes: string | null;
  cadence_days: number | null; tier_override: Tier | null;
  next_follow_up_at: string | null; last_contacted_at: string | null; created_at: string;
  po_count: number; spend_total: number; spend_recent: number; score: number;
  last_po_at: string | null; days_since_po: number | null; raw_gap: number | null;
  pr: number | null; item_types: string[]; days_late: number | null;
  rhythm: number[] | null;
};

/** A DATE column arrives from postgres.js as a JS Date at UTC midnight. Sent
 *  as an ISO timestamp it renders a day early anywhere west of UTC — "call
 *  Sep 11" shows as Sep 10 in Denver — and it would not match the plain date
 *  the log-contact response returns. Calendar dates stay calendar dates. */
function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function toApi(r: Row, s: CrmSettings) {
  const tier = tierFor(r.pr, r.tier_override);
  const cadence = cadenceFor(tier, r.status, r.cadence_days, s);
  const health = healthFor({
    standing: r.status,
    poCount: r.po_count,
    daysSinceLastPo: r.days_since_po,
    rawGapDays: r.raw_gap,
    cadenceDays: cadence,
  }, s);
  const daysUntilDue = r.days_late === null ? null : -r.days_late;
  return {
    id: r.id, name: r.name, company: r.company, phone: r.phone, email: r.email,
    address: {
      street1: r.street1, street2: r.street2, city: r.city,
      state: r.state, zip: r.zip, country: r.country,
    },
    ownerId: r.owner_id, ownerName: r.owner_name,
    source: r.source, status: r.status, supplies: r.supplies ?? [],
    preferences: {
      payment: r.pref_payment, logistics: r.pref_logistics, contact: r.pref_contact,
      bestTime: r.pref_best_time, price: r.pref_price,
    },
    notes: r.notes,
    // Derived — a client sends none of these back on PATCH.
    tier, tierPinned: r.tier_override !== null, cadenceDays: cadence, health,
    typicalGapDays: r.raw_gap === null ? null : Math.round(r.raw_gap),
    measuredGapDays: Math.round(effectiveGap(r.raw_gap, cadence, s)),
    poCount: r.po_count, spendTotal: r.spend_total, spendRecent: r.spend_recent,
    lastPoAt: r.last_po_at, daysSinceLastPo: r.days_since_po,
    itemTypes: r.item_types ?? [],
    rhythm: r.rhythm ?? [],
    nextFollowUpAt: isoDate(r.next_follow_up_at), lastContactedAt: r.last_contacted_at,
    daysUntilDue, dueState: dueStateFor(daysUntilDue),
    createdAt: r.created_at,
  };
}

/** Reads use effectiveRole so a manager previewing as a purchaser sees a
 *  narrowed book; writes consult user.role directly (lib/role.ts: the preview
 *  is a viewing convenience, not a permission demotion). */
function readScope(sql: ReturnType<typeof getDb>, u: User) {
  return effectiveRole(u) === 'manager' ? sql`TRUE` : sql`s.owner_id = ${u.id}`;
}
function canWrite(u: User, ownerId: string | null): boolean {
  return u.role === 'manager' || ownerId === u.id;
}

/** The rollup every read shares. Tier ranking runs over the whole company, not
 *  the caller's slice: tier means business value, not local ranking, so a
 *  purchaser whose clients are all small should see that honestly. */
function rollup(sql: ReturnType<typeof getDb>, floor: number) {
  return sql`
    WITH po AS (
      SELECT o.supplier_id,
             COUNT(*)::int AS po_count,
             COALESCE(SUM(o.total_cost), 0)::float AS spend_total,
             COALESCE(SUM(o.total_cost) FILTER (
               WHERE o.created_at > NOW() - INTERVAL '365 days'), 0)::float AS spend_recent,
             ${sql.unsafe(SCORE_SQL)} AS score,
             MAX(o.created_at) AS last_po_at,
             -- Days-ago per order, newest first: the marks the rhythm strip
             -- draws on every row. Capped so a very old client cannot bloat
             -- the list payload.
             (array_agg((NOW()::date - o.created_at::date)
                        ORDER BY o.created_at DESC))[1:60] AS rhythm
      FROM orders o
      WHERE o.supplier_id IS NOT NULL AND o.archived_at IS NULL
      GROUP BY o.supplier_id
    ), gap AS (
      SELECT supplier_id,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY g)::float AS raw_gap
      FROM (
        SELECT o.supplier_id,
               EXTRACT(EPOCH FROM (o.created_at - LAG(o.created_at)
                 OVER (PARTITION BY o.supplier_id ORDER BY o.created_at))) / 86400.0 AS g
        FROM orders o
        WHERE o.supplier_id IS NOT NULL AND o.archived_at IS NULL
      ) x
      WHERE g IS NOT NULL
      GROUP BY supplier_id
    ), items AS (
      SELECT o.supplier_id,
             -- item_type arrived in 0082 and is null on everything older, so
             -- fall back to the line's category, which is NOT NULL. Keying on
             -- item_type alone leaves this empty for most real history.
             array_agg(DISTINCT COALESCE(NULLIF(btrim(ol.item_type), ''), ol.category))
               FILTER (WHERE COALESCE(NULLIF(btrim(ol.item_type), ''), ol.category) IS NOT NULL)
               AS item_types
      FROM orders o
      JOIN order_lines ol ON ol.order_id = o.id
      WHERE o.supplier_id IS NOT NULL AND o.archived_at IS NULL
      GROUP BY o.supplier_id
    ), tierrank AS (
      SELECT id, percent_rank() OVER (ORDER BY score DESC) AS pr
      FROM (
        SELECT s2.id, COALESCE(po2.score, 0) AS score
        FROM suppliers s2
        LEFT JOIN po po2 ON po2.supplier_id = s2.id
        WHERE s2.status = 'active' AND COALESCE(po2.score, 0) >= ${floor}
      ) q
    )
    SELECT s.id, s.name, s.company, s.phone, s.email, s.street1, s.street2, s.city,
           s.state, s.zip, s.country, s.owner_id, u.name AS owner_name, s.source, s.status,
           s.supplies, s.pref_payment, s.pref_logistics, s.pref_contact, s.pref_best_time,
           s.pref_price, s.notes, s.cadence_days, s.tier_override, s.next_follow_up_at,
           s.last_contacted_at, s.created_at,
           COALESCE(po.po_count, 0) AS po_count,
           COALESCE(po.spend_total, 0)::float AS spend_total,
           COALESCE(po.spend_recent, 0)::float AS spend_recent,
           COALESCE(po.score, 0)::float AS score,
           po.last_po_at, po.rhythm,
           (NOW()::date - po.last_po_at::date) AS days_since_po,
           gap.raw_gap, tierrank.pr,
           COALESCE(items.item_types, '{}') AS item_types,
           (CURRENT_DATE - s.next_follow_up_at) AS days_late
    FROM suppliers s
    LEFT JOIN users u   ON u.id = s.owner_id
    LEFT JOIN po        ON po.supplier_id = s.id
    LEFT JOIN gap       ON gap.supplier_id = s.id
    LEFT JOIN items     ON items.supplier_id = s.id
    LEFT JOIN tierrank  ON tierrank.id = s.id
  `;
}

// ── List ───────────────────────────────────────────────────────────────────
// `follow` and `health` are the rail's filters. They are applied after the
// rollup because both are derived, not columns.
suppliers.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const s = await loadCrmSettings(sql);
  const q = c.req.query('q')?.toLowerCase().trim() || null;
  const status = c.req.query('status') ?? 'live';   // live | prospect | archived | all
  const follow = c.req.query('follow') ?? 'all';    // due | soon | all
  const health = c.req.query('health') ?? 'all';    // quiet | all
  const limit = clampLimit(c.req.query('limit'), 200, 500);

  const rows = (await sql`
    ${rollup(sql, s.tierFloorUsd)}
    WHERE ${readScope(sql, u)}
      AND (
        ${status} = 'all'
        OR (${status} = 'live'     AND s.status IN ('prospect','active'))
        OR (${status} = 'prospect' AND s.status = 'prospect')
        OR (${status} = 'archived' AND s.status = 'archived')
      )
      AND (
        ${q}::text IS NULL
        OR LOWER(s.name) LIKE '%' || ${q ?? ''} || '%'
        OR LOWER(COALESCE(s.company,'')) LIKE '%' || ${q ?? ''} || '%'
        OR LOWER(COALESCE(s.city,''))    LIKE '%' || ${q ?? ''} || '%'
        OR COALESCE(s.phone,'')          LIKE '%' || ${q ?? ''} || '%'
        OR LOWER(COALESCE(s.email,''))   LIKE '%' || ${q ?? ''} || '%'
        OR EXISTS (SELECT 1 FROM unnest(s.supplies) t WHERE LOWER(t) LIKE '%' || ${q ?? ''} || '%')
      )
    ORDER BY (s.next_follow_up_at IS NULL), s.next_follow_up_at, s.name
    LIMIT ${limit}
  `) as unknown as Row[];

  const items = rows.map((r) => toApi(r, s));
  const live = items.filter((i) => i.status !== 'archived');
  const counts = {
    due:   live.filter((i) => i.dueState === 'overdue' || i.dueState === 'today').length,
    soon:  live.filter((i) => i.dueState === 'soon').length,
    quiet: live.filter((i) => i.health === 'quiet' || i.health === 'lost').length,
    total: live.length,
  };
  const filtered = items.filter((i) => {
    if (follow === 'due'  && !(i.dueState === 'overdue' || i.dueState === 'today')) return false;
    if (follow === 'soon' && i.dueState !== 'soon') return false;
    if (health === 'quiet' && !(i.health === 'quiet' || i.health === 'lost')) return false;
    return true;
  });
  return c.json({ items: filtered, counts, settings: { cadenceDays: s.cadenceDays } });
});

// ── Suggestions ────────────────────────────────────────────────────────────
// Registered before `/:id` so the literal segment is not swallowed by the
// param route — the same trap customers.ts documents at its vendor-link PATCH.
//
// Sellers already visible in shipping/packages who have no client record and
// have not been waved off. Buying a label deliberately creates nothing: this
// business buys from plenty of people once, and auto-creating would bury the
// twenty relationships that matter under two hundred that do not.
suppliers.get('/suggestions', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const scope = effectiveRole(u) === 'manager' ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const rows = await sql`
    WITH seen AS (
      SELECT o.user_id AS owner_id,
             ${sql.unsafe(COMPRESS('sh.from_name'))} AS ck,
             regexp_replace(btrim(sh.from_name), '[[:space:]]+', ' ', 'g') AS name,
             sh.from_city AS city, sh.from_state AS state, sh.from_zip AS zip,
             sh.from_phone AS phone, sh.from_street1 AS street1, sh.from_street2 AS street2,
             sh.from_country AS country, o.id AS order_id, o.total_cost, sh.created_at
      FROM shipments sh
      JOIN orders o ON o.id = sh.order_id
      WHERE ${scope} AND sh.from_name IS NOT NULL AND btrim(sh.from_name) <> ''
        AND sh.from_street1 IS NOT NULL AND sh.from_city IS NOT NULL
        AND sh.from_state IS NOT NULL AND sh.from_zip IS NOT NULL
      UNION ALL
      SELECT o.user_id,
             ${sql.unsafe(COMPRESS('p.seller_name'))},
             regexp_replace(btrim(p.seller_name), '[[:space:]]+', ' ', 'g'),
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, o.id, o.total_cost, p.created_at
      FROM packages p
      JOIN orders o ON o.id = p.order_id
      WHERE ${scope} AND p.seller_name IS NOT NULL AND btrim(p.seller_name) <> ''
    ), agg AS (
      SELECT DISTINCT ON (owner_id, ck)
        owner_id, ck, name, city, state, zip, phone, street1, street2, country,
        COUNT(*)          OVER (PARTITION BY owner_id, ck)::int  AS po_count,
        SUM(COALESCE(total_cost,0)) OVER (PARTITION BY owner_id, ck)::float AS spend,
        MAX(created_at)   OVER (PARTITION BY owner_id, ck)        AS last_seen
      FROM seen
      ORDER BY owner_id, ck, created_at DESC
    )
    SELECT a.* FROM agg a
    WHERE NOT EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.owner_id IS NOT DISTINCT FROM a.owner_id
        AND ${sql.unsafe(COMPRESS('s.name'))} = a.ck)
    AND NOT EXISTS (
      SELECT 1 FROM supplier_suggestion_dismissals d
      WHERE d.user_id = ${u.id} AND d.match_key = a.ck)
    ORDER BY a.spend DESC, a.last_seen DESC
    LIMIT 25
  `;
  return c.json({
    items: rows.map((r) => ({
      matchKey: r.ck, name: r.name, ownerId: r.owner_id,
      city: r.city, state: r.state, zip: r.zip, phone: r.phone,
      street1: r.street1, street2: r.street2, country: r.country,
      poCount: r.po_count, spend: r.spend, lastSeen: r.last_seen,
      source: r.street1 ? 'shipping' : 'package',
    })),
  });
});

suppliers.post('/suggestions/dismiss', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as { matchKey?: string } | null;
  if (!body?.matchKey) return c.json({ error: 'matchKey is required' }, 400);
  const sql = getDb(c.env);
  await sql`
    INSERT INTO supplier_suggestion_dismissals (user_id, match_key)
    VALUES (${u.id}, ${body.matchKey})
    ON CONFLICT DO NOTHING
  `;
  return c.json({ ok: true });
});

suppliers.post('/suggestions/restore', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as { matchKey?: string } | null;
  if (!body?.matchKey) return c.json({ error: 'matchKey is required' }, 400);
  const sql = getDb(c.env);
  await sql`
    DELETE FROM supplier_suggestion_dismissals
    WHERE user_id = ${u.id} AND match_key = ${body.matchKey}
  `;
  return c.json({ ok: true });
});

// ── Adopt a suggestion ─────────────────────────────────────────────────────
// Creates the client AND attaches their past purchase orders in one
// transaction. Linking the history is the whole point: the record is complete
// the moment it exists, so nobody has to fill anything in.
suppliers.post('/adopt', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as {
    name?: string; ownerId?: string; phone?: string | null; street1?: string | null;
    street2?: string | null; city?: string | null; state?: string | null;
    zip?: string | null; country?: string | null; source?: string;
  } | null;
  if (!body?.name?.trim()) return c.json({ error: 'name is required' }, 400);

  // A manager adopting on someone's behalf files it under that purchaser —
  // ownership follows the purchase orders, not whoever clicked.
  const ownerId = u.role === 'manager' && body.ownerId ? body.ownerId : u.id;
  const source = body.source === 'package' ? 'package' : 'shipping';
  const sql = getDb(c.env);

  try {
    const out = await sql.begin(async (tx) => {
      const ins = await tx`
        INSERT INTO suppliers (name, phone, street1, street2, city, state, zip, country,
                               owner_id, source, status, created_by)
        VALUES (${body.name!.trim()}, ${body.phone ?? null}, ${body.street1 ?? null},
                ${body.street2 ?? null}, ${body.city ?? null}, ${body.state ?? null},
                ${body.zip ?? null}, ${body.country ?? 'US'}, ${ownerId}, ${source},
                'active', ${u.id})
        RETURNING id, match_key
      `;
      const id = ins[0].id as string;

      // Same two-pass match as the 0113 backfill: shipments by name+zip, then
      // packages by name alone (a package carries no address to match on).
      const byShip = await tx`
        UPDATE orders o SET supplier_id = ${id}
        WHERE o.supplier_id IS NULL
          AND o.user_id IS NOT DISTINCT FROM ${ownerId}
          AND EXISTS (
            SELECT 1 FROM shipments sh
            WHERE sh.order_id = o.id AND sh.from_zip IS NOT NULL
              AND ${sql.unsafe(COMPRESS('sh.from_name'))} || '|' || sh.from_zip = ${ins[0].match_key})
        RETURNING o.id
      `;
      const compressed = (ins[0].match_key as string).split('|')[0];
      const byPkg = await tx`
        UPDATE orders o SET supplier_id = ${id}
        WHERE o.supplier_id IS NULL
          AND o.user_id IS NOT DISTINCT FROM ${ownerId}
          AND EXISTS (
            SELECT 1 FROM packages p
            WHERE p.order_id = o.id AND p.seller_name IS NOT NULL
              AND ${sql.unsafe(COMPRESS('p.seller_name'))} = ${compressed})
        RETURNING o.id
      `;
      const linked = byShip.length + byPkg.length;

      // Seed the schedule from real history so an adopted client lands in the
      // rail with a sensible date instead of no date at all.
      await tx`
        UPDATE suppliers SET
          last_contacted_at = (SELECT MAX(created_at) FROM orders WHERE supplier_id = ${id}),
          next_follow_up_at = CURRENT_DATE
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO supplier_notes (supplier_id, author_id, kind, body)
        VALUES (${id}, ${u.id}, 'note',
                ${`Added from ${source === 'package' ? 'a tracked package' : 'shipping history'}` +
                  (linked ? ` — ${linked} past purchase order${linked > 1 ? 's' : ''} linked` : '')})
      `;
      return { id, linked };
    });
    return c.json(out, 201);
  } catch (e) {
    if (String(e).includes('suppliers_owner_match_idx')) {
      return c.json({ error: 'That client is already in the book' }, 409);
    }
    throw e;
  }
});

// ── Create ─────────────────────────────────────────────────────────────────
// Name is the only required field. Everything else can wait for the first
// conversation — asking for more up front is how a form stops getting used.
suppliers.post('/', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as
    | (Record<string, unknown> & { name?: string }) | null;
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'name is required' }, 400);
  }
  const bad = validate(body);
  if (bad) return c.json({ error: bad }, 400);

  const sql = getDb(c.env);
  const ownerId = u.role === 'manager' && typeof body.ownerId === 'string'
    ? (body.ownerId as string) : u.id;
  const status = body.status === 'prospect' ? 'prospect' : 'active';
  const s = await loadCrmSettings(sql);
  // A new lead with no schedule is a lead nobody calls, so one is set on
  // creation rather than waiting for the first logged contact.
  const due = isoDatePlus(status === 'prospect' ? s.cadenceDays.prospect : s.cadenceDays.C);

  try {
    const r = await sql`
      INSERT INTO suppliers (name, company, phone, email, street1, street2, city, state, zip,
                             country, owner_id, source, status, supplies, pref_payment,
                             pref_logistics, pref_contact, pref_best_time, pref_price, notes,
                             next_follow_up_at, created_by)
      VALUES (${body.name.trim()}, ${str(body.company)}, ${str(body.phone)}, ${str(body.email)},
              ${str(body.street1)}, ${str(body.street2)}, ${str(body.city)}, ${str(body.state)},
              ${str(body.zip)}, ${str(body.country) ?? 'US'}, ${ownerId},
              ${typeof body.source === 'string' ? body.source : 'manual'}, ${status},
              ${(body.supplies as string[]) ?? []}, ${str(body.prefPayment)},
              ${str(body.prefLogistics)}, ${str(body.prefContact)}, ${str(body.prefBestTime)},
              ${str(body.prefPrice)}, ${str(body.notes)}, ${due}, ${u.id})
      RETURNING id
    `;
    return c.json({ id: r[0].id }, 201);
  } catch (e) {
    if (String(e).includes('suppliers_owner_match_idx')) {
      const dup = await sql`
        SELECT s.name, u2.name AS owner FROM suppliers s
        LEFT JOIN users u2 ON u2.id = s.owner_id
        WHERE ${sql.unsafe(COMPRESS('s.name'))} = ${
          body.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')}
        LIMIT 1
      `;
      // Naming the owner is a deliberate, narrow exception to owner-scoping: it
      // costs a little privacy and stops two purchasers cold-calling the same
      // seller in the same week, which is worse.
      return c.json({
        error: dup[0]?.owner
          ? `${dup[0].name} is already in ${dup[0].owner}'s clients`
          : 'That client is already in the book',
      }, 409);
    }
    throw e;
  }
});

// ── Detail ─────────────────────────────────────────────────────────────────
suppliers.get('/:id', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const s = await loadCrmSettings(sql);
  const id = c.req.param('id');
  const rows = (await sql`
    ${rollup(sql, s.tierFloorUsd)} WHERE s.id = ${id} AND ${readScope(sql, u)}
  `) as unknown as Row[];
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);

  const [timeline, orders, sold] = await Promise.all([
    sql`SELECT n.id, n.kind, n.body, n.created_at, u2.name AS author
        FROM supplier_notes n LEFT JOIN users u2 ON u2.id = n.author_id
        WHERE n.supplier_id = ${id} ORDER BY n.created_at DESC LIMIT 100`,
    sql`SELECT o.id, o.lifecycle, o.total_cost::float AS total_cost, o.created_at
        FROM orders o WHERE o.supplier_id = ${id} ORDER BY o.created_at DESC LIMIT 50`,
    // What they have actually sold us, straight off the lines. Never typed, so
    // it cannot go stale.
    sql`SELECT COALESCE(NULLIF(btrim(ol.item_type), ''), ol.category, 'Other') AS item_type,
               SUM(ol.qty)::int AS qty,
               SUM(ol.qty * COALESCE(ol.unit_cost, 0))::float AS spend
        FROM order_lines ol JOIN orders o ON o.id = ol.order_id
        WHERE o.supplier_id = ${id} AND o.archived_at IS NULL
        GROUP BY 1 ORDER BY qty DESC LIMIT 12`,
    ]);
  // The contact log is `timeline`, NOT `notes`: suppliers.notes is the client's
  // own free-text note and toApi already returns it under that name. Spreading
  // a `notes` array over it silently replaced a string with rows.
  return c.json({
    ...toApi(rows[0], s),
    canEdit: canWrite(u, rows[0].owner_id),
    timeline, orders, sold,
  });
});

// ── Update ─────────────────────────────────────────────────────────────────
// Presence-checked rather than COALESCEd: customers.ts uses
// `COALESCE(${v ?? null}, col)`, which silently ignores an explicit null, so a
// field there can never be cleared once set. Sending null here clears.
suppliers.patch('/:id', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'Body required' }, 400);
  const bad = validate(body);
  if (bad) return c.json({ error: bad }, 400);

  const cur = (await sql`SELECT id, owner_id FROM suppliers WHERE id = ${id}`)[0] as
    { id: string; owner_id: string | null } | undefined;
  if (!cur) return c.json({ error: 'Not found' }, 404);
  if (!canWrite(u, cur.owner_id)) return c.json({ error: 'Forbidden' }, 403);
  if (body.tierOverride !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can pin a tier' }, 403);
  }
  if (body.ownerId !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can reassign a client' }, 403);
  }

  const set = (k: string, col: string) => body[k] !== undefined
    ? sql`, ${sql.unsafe(col)} = ${body[k] === null ? null : (body[k] as never)}`
    : sql``;
  await sql`
    UPDATE suppliers SET updated_at = NOW()
      ${set('name', 'name')}${set('company', 'company')}${set('phone', 'phone')}
      ${set('email', 'email')}${set('street1', 'street1')}${set('street2', 'street2')}
      ${set('city', 'city')}${set('state', 'state')}${set('zip', 'zip')}
      ${set('country', 'country')}${set('status', 'status')}${set('supplies', 'supplies')}
      ${set('prefPayment', 'pref_payment')}${set('prefLogistics', 'pref_logistics')}
      ${set('prefContact', 'pref_contact')}${set('prefBestTime', 'pref_best_time')}
      ${set('prefPrice', 'pref_price')}${set('notes', 'notes')}
      ${set('cadenceDays', 'cadence_days')}${set('tierOverride', 'tier_override')}
      ${set('nextFollowUpAt', 'next_follow_up_at')}${set('ownerId', 'owner_id')}
    WHERE id = ${id}
  `;
  return c.json({ ok: true });
});

// ── Log a contact ──────────────────────────────────────────────────────────
// The follow-up engine. One transaction records what happened, marks them
// contacted, and schedules the next call — because if logging ever costs more
// than a couple of taps, purchasers will make calls and not log them, and the
// whole list starts lying.
const KINDS = new Set(['note', 'call', 'text', 'visit', 'offer']);
suppliers.post('/:id/notes', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    body?: string; kind?: string; nextFollowUpAt?: string | null; reschedule?: boolean;
  } | null;
  const kind = body?.kind ?? 'call';
  if (!KINDS.has(kind)) return c.json({ error: 'Unknown contact kind' }, 400);
  const text = (body?.body ?? '').trim();

  const s = await loadCrmSettings(sql);
  const rows = (await sql`
    ${rollup(sql, s.tierFloorUsd)} WHERE s.id = ${id}
  `) as unknown as Row[];
  const cur = rows[0];
  if (!cur) return c.json({ error: 'Not found' }, 404);
  if (!canWrite(u, cur.owner_id)) return c.json({ error: 'Forbidden' }, 403);

  const view = toApi(cur, s);
  // Explicit date wins; otherwise schedule from their cadence so doing nothing
  // is the correct action.
  const next = body?.nextFollowUpAt !== undefined && body.nextFollowUpAt !== null
    ? body.nextFollowUpAt
    : (body?.reschedule === false ? cur.next_follow_up_at : isoDatePlus(view.cadenceDays));

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO supplier_notes (supplier_id, author_id, kind, body)
      VALUES (${id}, ${u.id}, ${kind}, ${text || defaultBody(kind)})
    `;
    await tx`
      UPDATE suppliers
      SET last_contacted_at = NOW(), next_follow_up_at = ${next}, updated_at = NOW()
      WHERE id = ${id}
    `;
  });
  return c.json({ ok: true, nextFollowUpAt: next });
});

suppliers.delete('/:id/notes/:noteId', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const row = (await sql`
    SELECT n.id, n.author_id, s.owner_id FROM supplier_notes n
    JOIN suppliers s ON s.id = n.supplier_id
    WHERE n.id = ${c.req.param('noteId')} AND n.supplier_id = ${c.req.param('id')}
  `)[0] as { author_id: string | null; owner_id: string | null } | undefined;
  // Not your client at all -> 404, the same as GET /:id. Confirming the note
  // exists would leak another purchaser's book. Your client but someone else's
  // note -> 403, which is a distinction the caller is entitled to.
  if (!row || !canWrite(u, row.owner_id)) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && row.author_id !== u.id) {
    return c.json({ error: 'Only the person who wrote a note can delete it' }, 403);
  }
  await sql`DELETE FROM supplier_notes WHERE id = ${c.req.param('noteId')}`;
  return c.json({ ok: true });
});

// ── Reassign ───────────────────────────────────────────────────────────────
// A book handover has to be auditable, so it lands on the same timeline as the
// calls rather than in a silent column change. `null` sends the client to the
// house-account queue, which is where a departing purchaser's book goes.
suppliers.post('/:id/reassign', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { ownerId?: string | null } | null;
  if (body === null || !('ownerId' in body)) return c.json({ error: 'ownerId is required' }, 400);

  const cur = (await sql`
    SELECT s.id, s.owner_id, u2.name AS owner_name FROM suppliers s
    LEFT JOIN users u2 ON u2.id = s.owner_id WHERE s.id = ${id}
  `)[0] as { owner_id: string | null; owner_name: string | null } | undefined;
  if (!cur) return c.json({ error: 'Not found' }, 404);

  const to = body.ownerId ?? null;
  const toName = to
    ? ((await sql`SELECT name FROM users WHERE id = ${to}`)[0]?.name as string | undefined)
    : undefined;
  if (to && !toName) return c.json({ error: 'That purchaser does not exist' }, 400);

  try {
    await sql.begin(async (tx) => {
      await tx`UPDATE suppliers SET owner_id = ${to}, updated_at = NOW() WHERE id = ${id}`;
      await tx`
        INSERT INTO supplier_notes (supplier_id, author_id, kind, body)
        VALUES (${id}, ${u.id}, 'owner_changed',
                ${`Moved from ${cur.owner_name ?? 'house accounts'} to ${toName ?? 'house accounts'}`})
      `;
    });
  } catch (e) {
    if (String(e).includes('suppliers_owner_match_idx')) {
      return c.json({ error: `${toName} already has this client` }, 409);
    }
    throw e;
  }
  return c.json({ ok: true });
});

// ── helpers ────────────────────────────────────────────────────────────────
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

const STRING_FIELDS = [
  'name', 'company', 'phone', 'email', 'street1', 'street2', 'city', 'state', 'zip',
  'country', 'prefPayment', 'prefLogistics', 'prefContact', 'prefBestTime', 'prefPrice',
  'notes', 'source',
] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Type-check before the UPDATE, or `body.status as string` lets anything
 *  through to a CHECK constraint and returns a 500 instead of a 400. */
function validate(b: Record<string, unknown>): string | null {
  for (const f of STRING_FIELDS) {
    if (b[f] !== undefined && b[f] !== null && typeof b[f] !== 'string') {
      return `${f} must be text`;
    }
  }
  if (typeof b.email === 'string' && b.email.trim() !== '' && !EMAIL_RE.test(b.email.trim())) {
    return 'That email address does not look right';
  }
  if (b.supplies !== undefined && b.supplies !== null &&
      !(Array.isArray(b.supplies) && b.supplies.every((t) => typeof t === 'string'))) {
    return 'supplies must be a list of text';
  }
  if (b.status !== undefined &&
      !['prospect', 'active', 'archived'].includes(b.status as string)) {
    return 'Unknown status';
  }
  if (b.tierOverride !== undefined && b.tierOverride !== null &&
      !['A', 'B', 'C'].includes(b.tierOverride as string)) {
    return 'Unknown tier';
  }
  if (b.cadenceDays !== undefined && b.cadenceDays !== null &&
      (typeof b.cadenceDays !== 'number' || b.cadenceDays < 1 || b.cadenceDays > 365)) {
    return 'Contact interval must be between 1 and 365 days';
  }
  return null;
}

/** A logged call with no typed note still has to say something on the
 *  timeline — an empty row reads as a bug. */
function defaultBody(kind: string): string {
  switch (kind) {
    case 'call':  return 'Called';
    case 'text':  return 'Texted';
    case 'visit': return 'Visited';
    case 'offer': return 'Made an offer';
    default:      return 'Note';
  }
}

export default suppliers;
