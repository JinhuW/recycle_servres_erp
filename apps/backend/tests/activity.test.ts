import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// Global activity feed — unions order_events, sell_order_events,
// inventory_events and ref_price_events into one reverse-chronological record.
// The interesting failure modes are all at the seams: the four tables disagree
// on actor column, on whether they have a `kind` at all, and on parent type.

type Ev = {
  id: string;
  area: 'po' | 'so' | 'inv' | 'price';
  createdAt: string;
  kind: string;
  action: string;
  target: string;
  targetRef: string | null;
  detail: Record<string, unknown>;
  actor: { id: string; name: string; initials: string } | null;
};
type Feed = { events: Ev[]; counts: Record<string, number>; nextCursor: string | null };

const get = (token: string, qs = '') =>
  api<Feed>('GET', `/api/activity${qs}`, { token });

// Seed one row into each ledger so every union branch has something to return.
// Written directly rather than through the routes: this suite is about the read
// path, and driving four full lifecycles would test the writers instead.
async function seedAllLedgers() {
  const sql = getTestDb();
  const [order] = await sql<{ id: string }[]>`SELECT id FROM orders LIMIT 1`;
  const [so] = await sql<{ id: string }[]>`SELECT id FROM sell_orders LIMIT 1`;
  const [line] = await sql<{ id: string }[]>`SELECT id FROM order_lines LIMIT 1`;
  const [rp] = await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`;
  const [alex] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;

  await sql`INSERT INTO order_events (order_id, actor_id, kind, detail)
            VALUES (${order.id}, ${alex.id}, 'advanced',
                    ${sql.json({ from: 'reviewing', to: 'done' })})`;
  await sql`INSERT INTO sell_order_events (sell_order_id, actor_id, kind, detail)
            VALUES (${so.id}, ${alex.id}, 'line_edited',
                    ${sql.json({ changes: [{ field: 'unit_price', from: 42, to: 38.5 }] })})`;
  await sql`INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
            VALUES (${line.id}, ${alex.id}, 'priced',
                    ${sql.json({ field: 'sell_price', from: null, to: 88 })})`;
  await sql`INSERT INTO ref_price_events (ref_price_id, price, source, note, actor_user_id)
            VALUES (${rp.id}, 38.50, 'manual', 'vendor quote', ${alex.id})`;

  return { orderId: order.id, sellOrderId: so.id, lineId: line.id, refPriceId: rp.id };
}

describe('global activity feed', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns rows from all four ledgers in one feed', async () => {
    await seedAllLedgers();
    const { token } = await loginAs(ALEX);

    const r = await get(token, '?limit=200');
    expect(r.status).toBe(200);

    const areas = new Set(r.body.events.map(e => e.area));
    expect(areas, 'every ledger must be represented').toEqual(
      new Set(['po', 'so', 'inv', 'price']),
    );
  });

  it('normalises raw kinds to one action vocabulary', async () => {
    await seedAllLedgers();
    const { token } = await loginAs(ALEX);
    const r = await get(token, '?limit=200');

    // order_events.advanced and sell_order_events.status_changed are the same
    // human concept; both must surface as `status`.
    const advanced = r.body.events.find(e => e.kind === 'advanced');
    expect(advanced?.action).toBe('status');
    // ref_price_events has no kind column at all — it's synthesised.
    const priced = r.body.events.find(e => e.area === 'price');
    expect(priced?.action).toBe('priced');
    expect(priced?.kind).toBe('priced');
  });

  it('is manager-only', async () => {
    await seedAllLedgers();
    const { token } = await loginAs(MARCUS);   // purchaser
    const r = await get(token);
    expect(r.status).toBe(403);
  });

  it('serves a manager who is previewing the app as a purchaser', async () => {
    await seedAllLedgers();
    const sql = getTestDb();
    await sql`UPDATE users
              SET preferences = COALESCE(preferences, '{}'::jsonb)
                                || ${sql.json({ 'tweaks.rolePreview': 'as_purchaser' })}
              WHERE email = ${ALEX}`;
    const { token } = await loginAs(ALEX);

    // Role preview is a viewing convenience, not a permission demotion — the
    // audit page must not vanish when a manager toggles it.
    const r = await get(token);
    expect(r.status).toBe(200);
  });

  it('keeps price events whose actor has been deleted', async () => {
    const sql = getTestDb();
    const [rp] = await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`;
    // actor_user_id is ON DELETE SET NULL, so an unattributed row is normal.
    await sql`INSERT INTO ref_price_events (ref_price_id, price, source, actor_user_id)
              VALUES (${rp.id}, 12.00, 'manual', NULL)`;
    const { token } = await loginAs(ALEX);

    const r = await get(token, '?area=price&limit=200');
    expect(r.status).toBe(200);
    const orphan = r.body.events.find(e => e.actor === null);
    expect(orphan, 'a NULL-actor price event must still appear').toBeDefined();
    expect(orphan!.target).toBeTruthy();
  });

  it('filters by area without touching the pill counts', async () => {
    await seedAllLedgers();
    const { token } = await loginAs(ALEX);

    const all = await get(token, '?limit=200');
    const so = await get(token, '?area=so&limit=200');

    expect(so.body.events.every(e => e.area === 'so')).toBe(true);
    // Counts ignore the area filter — that's the axis the pills switch.
    expect(so.body.counts).toEqual(all.body.counts);
    expect(so.body.counts.all).toBeGreaterThan(so.body.events.length);
  });

  it('excludes a whole ledger when the action cannot occur in it', async () => {
    await seedAllLedgers();
    const { token } = await loginAs(ALEX);

    // `moved` only exists in inventory_events (kind `transferred`). The other
    // three branches must match nothing rather than falling through to TRUE.
    const r = await get(token, '?action=moved&limit=200');
    expect(r.status).toBe(200);
    expect(r.body.events.every(e => e.area === 'inv')).toBe(true);
    expect(r.body.counts.po).toBe(0);
    expect(r.body.counts.so).toBe(0);
    expect(r.body.counts.price).toBe(0);
  });

  it('reaches a line-photo event under an action filter', async () => {
    const sql = getTestDb();
    const [order] = await sql<{ id: string }[]>`SELECT id FROM orders LIMIT 1`;
    const [alex] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    for (const kind of ['line_photo_added', 'line_photo_removed']) {
      await sql`INSERT INTO order_events (order_id, actor_id, kind, detail)
                VALUES (${order.id}, ${alex.id}, ${kind}, ${sql.json({ filename: 'label.jpg' })})`;
    }
    const { token } = await loginAs(ALEX);

    // A kind missing from ACTIVITY_KIND_MAP is reported as `edited` but named by
    // no action's kind list, so the row falls out of every filter value there is.
    const added = await get(token, '?action=added&limit=200');
    expect(added.body.events.find(e => e.kind === 'line_photo_added')?.action).toBe('added');
    const removed = await get(token, '?action=removed&limit=200');
    expect(removed.body.events.find(e => e.kind === 'line_photo_removed')?.action).toBe('removed');
  });

  it('rejects an unknown area or action instead of ignoring it', async () => {
    const { token } = await loginAs(ALEX);
    expect((await get(token, '?area=nope')).status).toBe(400);
    expect((await get(token, '?action=nope')).status).toBe(400);
  });

  it('paginates by keyset with no duplicates or gaps', async () => {
    const sql = getTestDb();
    const [order] = await sql<{ id: string }[]>`SELECT id FROM orders LIMIT 1`;
    const [alex] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    for (let i = 0; i < 12; i++) {
      await sql`INSERT INTO order_events (order_id, actor_id, kind, detail)
                VALUES (${order.id}, ${alex.id}, 'meta_changed', ${sql.json({ i })})`;
    }
    const { token } = await loginAs(ALEX);

    const first = await get(token, '?area=po&limit=5');
    expect(first.body.events).toHaveLength(5);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await get(token, `?area=po&limit=5&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    expect(second.body.events).toHaveLength(5);

    const ids = [...first.body.events, ...second.body.events].map(e => e.id);
    expect(new Set(ids).size, 'pages must not overlap').toBe(ids.length);

    // And the merged run must still be in strict reverse-chronological order.
    const times = [...first.body.events, ...second.body.events].map(e => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('searches across the differently-shaped ledgers', async () => {
    const { orderId } = await seedAllLedgers();
    const { token } = await loginAs(ALEX);

    const r = await get(token, `?q=${encodeURIComponent(orderId)}&limit=200`);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThan(0);
    expect(r.body.events.every(e => e.area === 'po')).toBe(true);
  });
});
