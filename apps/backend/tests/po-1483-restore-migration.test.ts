import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../migrations/0161_po_1483_restore_removed_lines.sql'),
  'utf8',
);

const L32 = 'd2e7da42-898a-44aa-9203-ba11c881702b';
const L36 = '20eb59db-1567-4aa8-bf48-9f84fc9c0698';

// The seed may or may not have a PO-1483; shape it like the real one, at
// Reviewing. `removed` replays the 2026-10-07 delete's audit rows.
async function shapePo1483({ removed }: { removed: boolean }) {
  const sql = getTestDb();
  const [actor] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY email LIMIT 1`;
  await sql`
    INSERT INTO orders (id, user_id, category, lifecycle)
    VALUES ('PO-1483', ${actor.id}, 'Mixed', 'reviewing')
    ON CONFLICT (id) DO UPDATE SET lifecycle = 'reviewing', archived_at = NULL`;
  if (removed) {
    for (const lineId of [L32, L36]) {
      await sql`
        INSERT INTO order_events (order_id, actor_id, kind, detail)
        VALUES ('PO-1483', ${actor.id}, 'line_removed',
                ${sql.json({ lineId, category: 'RAM', partNumber: 'x', qty: 1, unitCost: 25 })})`;
    }
  }
  return actor.id;
}

type Row = { id: string; position: number; qty: number; status: string; scan_image_id: string | null; created_at: Date };
const restored = async () =>
  getTestDb()<Row[]>`
    SELECT id, position, qty, status, scan_image_id, created_at FROM order_lines
    WHERE id IN (${L32}, ${L36}) ORDER BY position`;
const addedEvents = async () =>
  getTestDb()<{ actor_id: string; detail: { lineId: string; qty: number; restored?: boolean } }[]>`
    SELECT actor_id, detail FROM order_events
    WHERE order_id = 'PO-1483' AND kind = 'line_added' AND detail ? 'restored'
    ORDER BY detail->>'lineId'`;

describe('0161: PO-1483 gets lines #32 and #36 back at qty 0', () => {
  beforeEach(async () => { await resetDb(); });

  it('puts both lines back where they were, at 0, logged as a restore by whoever removed them', async () => {
    const actor = await shapePo1483({ removed: true });
    await getTestDb().unsafe(migration);

    const rows = await restored();
    expect(rows.map(r => [r.id, r.position, r.qty, r.status])).toEqual([
      [L32, 32, 0, 'Reviewing'],
      [L36, 36, 0, 'Reviewing'],
    ]);
    // Original created_at, so the # rank is what it was.
    expect(rows[0].created_at.toISOString()).toBe('2026-10-04T18:46:34.297Z');
    // #36's scan went with the delete; #32 shares #31's, which survived.
    expect(rows[0].scan_image_id).toMatch(/^label-scans\//);
    expect(rows[1].scan_image_id).toBeNull();

    const evs = await addedEvents();
    expect(evs.map(e => [e.detail.lineId, e.detail.qty, e.detail.restored, e.actor_id]))
      .toEqual([[L36, 0, true, actor], [L32, 0, true, actor]]);
  });

  it('does nothing the second time', async () => {
    await shapePo1483({ removed: true });
    await getTestDb().unsafe(migration);
    await getTestDb().unsafe(migration);
    expect(await restored()).toHaveLength(2);
    expect(await addedEvents()).toHaveLength(2);
  });

  it('does nothing without the removal on record', async () => {
    await shapePo1483({ removed: false });
    await getTestDb().unsafe(migration);
    expect(await restored()).toEqual([]);
    expect(await addedEvents()).toEqual([]);
  });

  it('skips a line whose id is already taken, and restores the other', async () => {
    await shapePo1483({ removed: true });
    const sql = getTestDb();
    await sql`
      INSERT INTO order_lines (id, order_id, category, qty, unit_cost, status, position)
      VALUES (${L32}, 'PO-1483', 'RAM', 4, 25, 'Reviewing', 32)`;
    await sql.unsafe(migration);
    const rows = await restored();
    expect(rows.map(r => [r.id, r.qty])).toEqual([[L32, 4], [L36, 0]]);
    expect((await addedEvents()).map(e => e.detail.lineId)).toEqual([L36]);
  });

  it('leaves an archived PO-1483 alone', async () => {
    await shapePo1483({ removed: true });
    await getTestDb()`UPDATE orders SET archived_at = now() WHERE id = 'PO-1483'`;
    await getTestDb().unsafe(migration);
    expect(await restored()).toEqual([]);
  });
});
