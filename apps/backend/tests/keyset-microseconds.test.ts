import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Rows created inside one millisecond — a sync, an import, a cascade — must
// page out exactly once each. A cursor encoded from a JS Date carried
// milliseconds only, so page two skipped or repeated rows in that window.
// Each route gets a burst far in the future so its rows lead the list.

const BURST = 5;
// 00:00:00.000100, .000107, … — all inside the same millisecond. Cast through
// text: a bare ${x}::timestamptz parameter goes through a JS Date and loses
// the microseconds (docs/debug-notes on the transfer-orders cursor).
const at = (i: number) => `2031-01-01 00:00:00.000${String(100 + i * 7).padStart(3, '0')}+00`;

async function walk(token: string, path: string, key: string, mine: Set<string>): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await api<Record<string, unknown>>('GET',
      `${path}${sep}limit=2${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { token });
    expect(r.status, path).toBe(200);
    const rows = r.body[key] as { id: string }[];
    for (const row of rows) if (mine.has(row.id)) seen.push(row.id);
    cursor = (r.body.nextCursor as string | null) ?? null;
    if (!cursor || seen.length >= mine.size) break;
  }
  return seen;
}

describe('keyset cursors keep microseconds', () => {
  beforeEach(async () => { await resetDb(); });

  it('pages a sub-millisecond burst exactly once on every list', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const [cust] = await db<{ id: string }[]>`SELECT id FROM customers LIMIT 1`;
    const [acct] = await db<{ id: string }[]>`
      INSERT INTO bank_accounts (source, external_id, name) VALUES ('mercury', 'us-acct', 'x') RETURNING id`;
    const ids: Record<string, string[]> = { orders: [], so: [], bank: [], itx: [], ws: [], ev: [] };
    for (let i = 0; i < BURST; i++) {
      const po = `PO-US-${i}`;
      await db`INSERT INTO orders (id, user_id, category, lifecycle, created_at)
               VALUES (${po}, ${u.id}, 'RAM', 'draft', (${at(i)}::text)::timestamptz)`;
      ids.orders.push(po);
      const so = `SO-US-${i}`;
      await db`INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
               VALUES (${so}, ${cust.id}, 'Draft', ${u.id}, (${at(i)}::text)::timestamptz, (${at(i)}::text)::timestamptz)`;
      ids.so.push(so);
      const [b] = await db<{ id: string }[]>`
        INSERT INTO bank_transactions (source, external_id, account_id, posted_at, amount, raw)
        VALUES ('mercury', ${'us-' + i}, ${acct.id}, (${at(i)}::text)::timestamptz, -1, '{}'::jsonb) RETURNING id`;
      ids.bank.push(b.id);
      const [t] = await db<{ id: string }[]>`
        INSERT INTO internal_transactions (title, created_by, created_at) VALUES (${'t' + i}, ${u.id}, (${at(i)}::text)::timestamptz) RETURNING id`;
      ids.itx.push(t.id);
      const ws = `WS-US-${i}`;
      await db`INSERT INTO web_submissions (id, site, kind, email, payload, created_at)
               VALUES (${ws}, 'ram4cash', 'quote', 'x@example.com', '{}'::jsonb, (${at(i)}::text)::timestamptz)`;
      ids.ws.push(ws);
      const [e] = await db<{ id: string }[]>`
        INSERT INTO order_events (order_id, actor_id, kind, created_at) VALUES (${po}, ${u.id}, 'created', (${at(i)}::text)::timestamptz) RETURNING id`;
      ids.ev.push(e.id);
    }
    const newestFirst = (xs: string[]) => [...xs].reverse();
    expect(await walk(token, '/api/orders', 'orders', new Set(ids.orders))).toEqual(newestFirst(ids.orders));
    expect(await walk(token, '/api/sell-orders', 'rows', new Set(ids.so))).toEqual(newestFirst(ids.so));
    expect(await walk(token, '/api/bank-transactions', 'rows', new Set(ids.bank))).toEqual(newestFirst(ids.bank));
    expect(await walk(token, '/api/internal-transactions', 'rows', new Set(ids.itx))).toEqual(newestFirst(ids.itx));
    expect(await walk(token, '/api/web-submissions', 'items', new Set(ids.ws))).toEqual(newestFirst(ids.ws));
    expect(await walk(token, '/api/activity?area=po', 'events', new Set(ids.ev))).toEqual(newestFirst(ids.ev));
  });

  it('treats a cursor whose timestamp is not one as the first page', async () => {
    const { token } = await loginAs(ALEX);
    const bad = btoa(JSON.stringify({ ts: "'; DROP TABLE x; --", id: 'x' })).replace(/=+$/, '');
    for (const path of ['/api/sell-orders', '/api/bank-transactions', '/api/internal-transactions', '/api/web-submissions', '/api/activity']) {
      expect((await api('GET', `${path}?cursor=${bad}`, { token })).status, path).toBe(200);
    }
  });
});
