// Migration 0113 turns shipping history into a client book. It runs before the
// seed when a worker builds its template database, so by the time fixtures
// exist it has already executed against an empty schema — a silent no-op in the
// normal suite. Rather than duplicate the SQL here, the test replays the real
// migration file over data it has just inserted.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

// `migrationsDir` is module-private in helpers/db.ts, so resolve it the same way.
const BACKFILL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0113_suppliers_backfill.sql'),
  'utf8',
);

async function seed() {
  const sql = getTestDb();
  const [marcus] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = 'marcus@recycleservers.io'`;
  const [priya] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = 'priya@recycleservers.io'`;
  const [wh] = await sql<{ id: string }[]>`SELECT id FROM warehouses LIMIT 1`;

  const po = async (id: string, owner: string, cost: number | null, days: number) => {
    await sql`
      INSERT INTO orders (id, user_id, category, warehouse_id, lifecycle, total_cost, created_at)
      VALUES (${id}, ${owner}, 'RAM', ${wh.id}, 'done', ${cost},
              NOW() - (${days} || ' days')::interval)`;
  };
  const ship = async (order: string, name: string, street: string, days: number,
                      phone: string | null) => {
    await sql`
      INSERT INTO shipments (order_id, from_name, from_phone, from_street1, from_city,
                             from_state, from_zip, weight_oz, length_in, width_in,
                             height_in, provider, created_at)
      VALUES (${order}, ${name}, ${phone}, ${street}, 'Aurora', 'CO', '80012',
              10, 1, 1, 1, 'stub', NOW() - (${days} || ' days')::interval)`;
  };

  await po('PO-B001', marcus.id, 5000, 95);
  await po('PO-B002', marcus.id, 7000, 20);
  await po('PO-B003', marcus.id, 900, 5);
  await po('PO-B004', priya.id, 3000, 10);
  await po('PO-B005', marcus.id, 400, 3);
  await po('PO-B006', marcus.id, null, 0);

  // Same seller, three spellings. The tidy one is used twice; the messy one is
  // newest and carries the current phone and a moved address.
  await ship('PO-B001', "John's Servers", '1 Main St', 95, null);
  await ship('PO-B001', "John's Servers", '1 Main St', 90, null);
  await ship('PO-B002', '  johns   SERVERS ', '9 New Rd', 20, '303-555-0142');
  await ship('PO-B004', 'Johns Servers', '1 Main St', 10, '303-555-0142');
  // A seller-fill shell with no address must be ignored entirely.
  await sql`
    INSERT INTO shipments (order_id, from_name, provider) VALUES ('PO-B006', 'Half Filled Co', 'stub')`;
  await sql`
    INSERT INTO packages (tracking_number, carrier, order_id, seller_name, created_at) VALUES
      ('1ZBACKFILL0000001','UPS','PO-B003','JOHNS SERVERS!!', NOW() - INTERVAL '5 days'),
      ('1ZBACKFILL0000002','UPS','PO-B005','  Mike   Trujillo ', NOW() - INTERVAL '3 days')`;
  return { marcus: marcus.id, priya: priya.id };
}

describe('0113 — seeding the book from history', () => {
  beforeEach(async () => { await resetDb(); });

  it('builds one client per seller per purchaser and attaches their orders', async () => {
    const sql = getTestDb();
    const ids = await seed();
    await sql.unsafe(BACKFILL);

    const rows = await sql<{ name: string; source: string; phone: string | null;
                            street1: string | null; owner_id: string | null }[]>`
      SELECT name, source, phone, street1, owner_id FROM suppliers ORDER BY owner_id, name`;

    const marcusRows = rows.filter((r) => r.owner_id === ids.marcus);
    expect(marcusRows.map((r) => r.name).sort()).toEqual(["John's Servers", 'Mike Trujillo']);

    // The display name is the spelling used most often, NOT the newest — one
    // hasty entry must not become what every screen shows forever.
    const john = marcusRows.find((r) => r.name === "John's Servers")!;
    expect(john.source).toBe('shipping');
    // ...while the contact details do come from the newest row, because an
    // address that changed is genuinely the current one.
    expect(john.phone).toBe('303-555-0142');
    expect(john.street1).toBe('9 New Rd');

    // Whitespace is collapsed on package-only sellers too.
    expect(marcusRows.find((r) => r.name === 'Mike Trujillo')!.source).toBe('package');

    // Each purchaser keeps their own record of the same company.
    expect(rows.filter((r) => r.owner_id === ids.priya).map((r) => r.name)).toEqual(['Johns Servers']);
  });

  it('attaches a package-only order to the existing client instead of forking one', async () => {
    const sql = getTestDb();
    await seed();
    await sql.unsafe(BACKFILL);
    const [{ name }] = await sql<{ name: string }[]>`
      SELECT s.name FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = 'PO-B003'`;
    expect(name).toBe("John's Servers");
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM suppliers WHERE regexp_replace(upper(name),'[^A-Z0-9]','','g') = 'JOHNSSERVERS'`;
    expect(Number(count)).toBe(2);   // one for Marcus, one for Priya — not four
  });

  it('ignores a seller-fill shell that has no address yet', async () => {
    const sql = getTestDb();
    await seed();
    await sql.unsafe(BACKFILL);
    const [{ supplier_id }] = await sql<{ supplier_id: string | null }[]>`
      SELECT supplier_id FROM orders WHERE id = 'PO-B006'`;
    expect(supplier_id).toBeNull();
    const shells = await sql`SELECT 1 FROM suppliers WHERE name = 'Half Filled Co'`;
    expect(shells.length).toBe(0);
  });

  it('seeds a follow-up schedule spread over two weeks, not all on one day', async () => {
    const sql = getTestDb();
    await seed();
    await sql.unsafe(BACKFILL);
    const rows = await sql<{ next_follow_up_at: Date | null; last_contacted_at: Date | null }[]>`
      SELECT next_follow_up_at, last_contacted_at FROM suppliers WHERE next_follow_up_at IS NOT NULL`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.last_contacted_at).not.toBeNull();
      const days = Math.round((r.next_follow_up_at!.getTime() - Date.now()) / 86_400_000);
      expect(days).toBeGreaterThanOrEqual(-1);
      expect(days).toBeLessThanOrEqual(14);
    }
  });

  it('is safe to run twice', async () => {
    const sql = getTestDb();
    await seed();
    await sql.unsafe(BACKFILL);
    const [a] = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM suppliers`;
    await sql.unsafe(BACKFILL);
    const [b] = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM suppliers`;
    expect(b.c).toBe(a.c);
  });
});
