import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0148_po_1339_total_follows_lines.sql'),
  'utf8',
);

// The seed has its own PO-1339; shape it like the real one. `empty` replays the
// 2026-07-23 incident: its lines moved to another PO, the $8,500 left behind.
async function shapePo1339(empty: boolean) {
  const sql = getTestDb();
  if (empty) {
    const [other] = await sql<{ id: string }[]>`SELECT id FROM orders WHERE id <> 'PO-1339' ORDER BY id LIMIT 1`;
    await sql`UPDATE order_lines SET order_id = ${other.id} WHERE order_id = 'PO-1339'`;
  }
  await sql`UPDATE orders SET total_cost = 8500 WHERE id = 'PO-1339'`;
}

const totalOf = async (id: string) =>
  (await getTestDb()<{ t: number }[]>`SELECT total_cost::float AS t FROM orders WHERE id = ${id}`)[0].t;

describe('0148: PO-1339 follows its (empty) lines', () => {
  beforeEach(async () => { await resetDb(); });

  it('zeroes only the empty PO-1339 carrying the stale $8,500', async () => {
    await shapePo1339(true);
    const sql = getTestDb();
    const [other] = await sql<{ id: string }[]>`SELECT id FROM orders WHERE id <> 'PO-1339' ORDER BY id DESC LIMIT 1`;
    await sql`UPDATE orders SET total_cost = 8500 WHERE id = ${other.id}`;
    await sql.unsafe(migration);
    expect(await totalOf('PO-1339')).toBe(0);
    expect(await totalOf(other.id)).toBe(8500);
  });

  it('leaves PO-1339 alone once it has a line again', async () => {
    await shapePo1339(false);
    await getTestDb().unsafe(migration);
    expect(await totalOf('PO-1339')).toBe(8500);
  });
});
