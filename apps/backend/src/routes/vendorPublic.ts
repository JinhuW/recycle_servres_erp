import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env } from '../types';
import { nextHumanId } from '../lib/id-seq';
import { notifyManagers } from '../lib/notify';
import { getLatestRateToUsd, isSupportedCurrency, type SupportedCurrency } from '../lib/fx';

const vendorPublic = new Hono<{ Bindings: Env }>();

type Link = { id: string; customer_id: string; label: string | null };

// Resolve a token to an active, non-expired link. Any miss returns null so
// callers can answer a uniform 404 (never reveal whether a token exists).
async function loadLink(sql: ReturnType<typeof getDb>, token: string): Promise<Link | null> {
  if (!token) return null;
  const rows = await sql<Link[]>`
    SELECT id, customer_id, label
    FROM vendor_links
    WHERE token = ${token} AND active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;
  return rows[0] ?? null;
}

vendorPublic.get('/:token/me', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  const cust = (await sql<{ name: string; short_name: string | null }[]>`
    SELECT name, short_name FROM customers WHERE id = ${link.customer_id} LIMIT 1
  `)[0];
  if (!cust) return c.json({ error: 'Not found' }, 404);
  return c.json({ customer: { name: cust.name, short: cust.short_name }, label: link.label });
});

vendorPublic.get('/:token/catalog', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  // Best-effort touch; ignore failures.
  await sql`UPDATE vendor_links SET last_seen_at = NOW() WHERE id = ${link.id}`.catch(() => {});

  // Explicit non-cost column list. NEVER select unit_cost / sell_price /
  // profit / margin / notes / user / warehouse.
  //
  // scan_image_url: prefer this line's own scan; if none, fall back to any
  // sibling line on a different PO that shares the same part_number — vendors
  // see one preview photo per product even when only some of the POs
  // happened to be photographed at intake.
  const rows = await sql<Record<string, unknown>[]>`
    WITH live AS (
      SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
             l.classification, l.rank, l.speed, l.interface, l.form_factor,
             l.description, l.part_number, l.condition, l.qty, l.created_at,
             ls.delivery_url AS own_scan_url
      FROM order_lines l
      LEFT JOIN label_scans ls ON ls.cf_image_id = l.scan_image_id
      WHERE l.status IN ('Reviewing', 'Done') AND l.qty > 0
    ),
    sib AS (
      SELECT part_number,
             (ARRAY_AGG(own_scan_url) FILTER (WHERE own_scan_url IS NOT NULL))[1]
               AS scan_url
      FROM live
      WHERE part_number IS NOT NULL AND part_number <> ''
      GROUP BY part_number
    )
    SELECT live.id, live.category, live.brand, live.capacity, live.generation,
           live.type, live.classification, live.rank, live.speed, live.interface,
           live.form_factor, live.description, live.part_number, live.condition,
           live.qty,
           COALESCE(live.own_scan_url, sib.scan_url) AS scan_image_url
    FROM live
    LEFT JOIN sib ON sib.part_number = live.part_number
    ORDER BY live.category, live.brand, live.created_at DESC
    LIMIT 2000
  `;
  const groups: { category: string; items: Record<string, unknown>[] }[] = [];
  for (const r of rows) {
    const cat = r.category as string;
    let g = groups.find(x => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  return c.json({ groups });
});

type BidLineIn = { inventoryId: string; qty: number; unitPrice: number };

vendorPublic.post('/:token/bids', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as
    | { contactName?: string; note?: string; currency?: string; lines?: BidLineIn[] }
    | null;
  const contactName = (body?.contactName ?? '').trim();
  const lines = Array.isArray(body?.lines) ? body!.lines : [];
  const note = (body?.note ?? '').slice(0, 2000) || null;
  if (!contactName || contactName.length > 120) {
    return c.json({ error: 'contactName required (<=120 chars)' }, 400);
  }
  if (lines.length < 1 || lines.length > 100) {
    return c.json({ error: 'lines must have 1..100 entries' }, 400);
  }
  for (const l of lines) {
    if (!l.inventoryId || !Number.isInteger(l.qty) || l.qty <= 0 ||
        !Number.isFinite(l.unitPrice) || l.unitPrice < 0 || l.unitPrice > 1e9) {
      return c.json({ error: 'each line needs inventoryId, qty>0, unitPrice>=0' }, 400);
    }
  }

  const rawCurrency = (body?.currency ?? 'USD').toUpperCase();
  if (!isSupportedCurrency(rawCurrency)) {
    return c.json({ error: 'unsupported currency' }, 400);
  }
  const currency = rawCurrency as SupportedCurrency;
  const fxLookup = await getLatestRateToUsd(sql, currency);
  const fxRateToUsd = fxLookup.rate;
  // The vendor_bids.fx_source column has no CHECK, but 'fixed' is a
  // synthetic source emitted only for USD. Normalise to 'manual' there so
  // downstream readers see one of {'frankfurter','manual'} (matching the
  // fx_rates.source CHECK), which is exactly what "no automatic rate; 1 by
  // convention" means.
  const fxSource = currency === 'USD' ? 'manual' : fxLookup.source;

  // Per-link flood throttle: count this link's recent bids in a sliding
  // window (same windowed-COUNT idiom as auth.ts's login_attempts gate).
  // Runs after cheap input validation (so a malformed body still 400s) and
  // before nextHumanId/tx so abuse can't burn id-seq rows.
  const recent = (await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM vendor_bids
    WHERE vendor_link_id = ${link.id}
      AND created_at > NOW() - INTERVAL '10 minutes'
  `)[0].n;
  if (recent >= 10) {
    return c.json({ error: 'too many offers; please try again later' }, 429);
  }

  type Outcome =
    | { code: 201; bidId: string }
    | { code: 409; bad: string[] }
    | { code: 400; msg: string };
  let outcome: Outcome = { code: 400, msg: 'unknown' };

  const bidId = await nextHumanId(sql, 'VB', 'VB');

  // Aggregate requested qty per inventory_id BEFORE the row check. The
  // per-line guard alone sees each duplicate line independently against the
  // same row.qty and lets all of them through; the sum then exceeds the cap.
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(l.inventoryId, (wanted.get(l.inventoryId) ?? 0) + l.qty);

  await sql.begin(async (tx) => {
    const bad: string[] = [];
    const snap: Record<string, { category: string; label: string; sub: string | null; pn: string | null }> = {};
    for (const [inventoryId, totalQty] of wanted) {
      const row = (await tx<{ category: string; brand: string | null; capacity: string | null;
        type: string | null; part_number: string | null; qty: number; status: string }[]>`
        SELECT category, brand, capacity, type, part_number, qty, status
        FROM order_lines WHERE id = ${inventoryId} FOR UPDATE
      `)[0];
      const sellable = row && (row.status === 'Reviewing' || row.status === 'Done');
      if (!sellable || row.qty < totalQty) { bad.push(inventoryId); continue; }
      snap[inventoryId] = {
        category: row.category,
        label: [row.brand, row.capacity, row.type].filter(Boolean).join(' ') || row.category,
        sub: row.part_number,
        pn: row.part_number,
      };
    }
    if (bad.length) { outcome = { code: 409, bad }; return; } // roll back

    await tx`
      INSERT INTO vendor_bids
        (id, vendor_link_id, customer_id, contact_name, note,
         currency_code, fx_rate_to_usd, fx_source)
      VALUES
        (${bidId}, ${link.id}, ${link.customer_id}, ${contactName}, ${note},
         ${currency}, ${fxRateToUsd}, ${fxSource})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; const s = snap[l.inventoryId];
      await tx`
        INSERT INTO vendor_bid_lines
          (bid_id, inventory_id, category, label, sub_label, part_number,
           offered_qty, offered_unit_price, position)
        VALUES
          (${bidId}, ${l.inventoryId}, ${s.category}, ${s.label}, ${s.sub},
           ${s.pn}, ${l.qty}, ${l.unitPrice}, ${i})
      `;
    }
    await notifyManagers(tx, {
      kind: 'vendor_bid', tone: 'info', icon: 'tag',
      title: 'New vendor offer',
      body: `${lines.length} item(s) from ${contactName}`,
    });
    outcome = { code: 201, bidId };
  });

  // `outcome` is set inside the sql.begin closure; TS control-flow narrowing
  // can't see those assignments and pins it to the initializer type, so cast
  // back to the declared union before branching (same `as` pattern as
  // sellOrders.ts's post-tx outcome handling).
  const result = outcome as Outcome;
  if (result.code === 409) return c.json({ error: 'Some items are no longer available', unavailable: result.bad }, 409);
  if (result.code !== 201) return c.json({ error: result.msg }, 400);
  return c.json({ bidId: result.bidId }, 201);
});

vendorPublic.get('/:token/bids', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  const bids = await sql<{ id: string; contact_name: string; note: string | null;
    status: string; created_at: string; currency_code: string;
    fx_rate_to_usd: number; fx_source: string }[]>`
    SELECT id, contact_name, note, status, created_at,
           currency_code, fx_rate_to_usd::float AS fx_rate_to_usd, fx_source
    FROM vendor_bids WHERE vendor_link_id = ${link.id}
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const lines = await sql<{ bid_id: string; label: string; offered_qty: number;
    offered_unit_price: number; line_status: string;
    accepted_qty: number | null; accepted_unit_price: number | null }[]>`
    SELECT bid_id, label, offered_qty, offered_unit_price::float AS offered_unit_price,
           line_status, accepted_qty, accepted_unit_price::float AS accepted_unit_price
    FROM vendor_bid_lines
    WHERE bid_id IN (SELECT id FROM vendor_bids WHERE vendor_link_id = ${link.id})
    ORDER BY position
    LIMIT 5000
  `;
  return c.json({
    bids: bids.map(b => {
      const bidLines = lines.filter(l => l.bid_id === b.id);
      const totalSource = bidLines.reduce(
        (acc, l) => acc + l.offered_unit_price * l.offered_qty, 0);
      const usdEquivalent = Math.round(totalSource * b.fx_rate_to_usd * 100) / 100;
      return {
        id: b.id, contactName: b.contact_name, note: b.note,
        status: b.status, createdAt: b.created_at,
        currency: b.currency_code,
        fxRateToUsd: b.fx_rate_to_usd,
        fxSource: b.fx_source,
        usdEquivalent,
        lines: bidLines.map(l => ({
          label: l.label, offeredQty: l.offered_qty, offeredUnitPrice: l.offered_unit_price,
          status: l.line_status, acceptedQty: l.accepted_qty, acceptedUnitPrice: l.accepted_unit_price,
        })),
      };
    }),
  });
});

vendorPublic.get('/:token/fx', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  const cny = await getLatestRateToUsd(sql, 'CNY');
  return c.json({
    USD_CNY: 1 / cny.rate,
    source: cny.source,
    fetchedAt: cny.fetchedAt.toISOString(),
    effectiveDate: cny.effectiveDate,
  });
});

export default vendorPublic;
