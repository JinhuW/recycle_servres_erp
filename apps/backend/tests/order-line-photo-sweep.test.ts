import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// R2 is not transactional, so removing a line queues its objects for deletion
// AFTER the commit. Which objects get queued is the whole question, and nothing
// downstream can answer it — a stub key deletes to a no-op and a real one is
// gone. So this file watches the call itself.
const { swept } = vi.hoisted(() => ({ swept: [] as string[] }));
vi.mock('../src/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/r2')>();
  return {
    ...actual,
    deleteAttachment: async (_env: unknown, key: string) => { swept.push(key); },
    // The post-commit sweeps batch, so watching only the single-key form would
    // record nothing and every assertion here would pass vacuously.
    deleteAttachments: async (_env: unknown, keys: readonly string[]) => {
      swept.push(...keys);
      return [];
    },
  };
});

async function png(size = 8): Promise<File> {
  const buf = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 20, g: 110, b: 76 } },
  }).png().toBuffer();
  return new File([new Uint8Array(buf)], 'dimm.png', { type: 'image/png' });
}

// A two-line PO (a PO must keep at least one line, so removals need a spare)
// whose first line carries a photo. Returns that line's id and storage key.
async function poWithPhoto(token: string, tag: string) {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', partNumber: tag + '-A', condition: 'New', qty: 1, unitCost: 50 },
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', partNumber: tag + '-B', condition: 'New', qty: 1, unitCost: 25 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const detail = await api<{ order: { lines: { id: string }[] } }>('GET', '/api/orders/' + id, { token });
  const lineId = detail.body.order.lines[0].id;

  expect((await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token })).status).toBe(200);
  const [row] = await getTestDb()<{ storage_key: string }[]>`
    SELECT storage_key FROM order_line_photos WHERE order_line_id = ${lineId}::uuid
  `;
  return { id, lineId, storageKey: row.storage_key };
}

describe('PATCH removeLineIds — the post-commit R2 sweep', () => {
  beforeEach(async () => { await resetDb(); swept.length = 0; });

  it('deletes the photos of the lines it actually removed', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId, storageKey } = await poWithPhoto(token, 'SWEEP-OWN');

    const r = await api('PATCH', '/api/orders/' + id, { token, body: { removeLineIds: [lineId] } });
    expect(r.status).toBe(200);
    expect(swept).toContain(storageKey);
  });

  it('leaves another order\'s photos alone when its line id is passed', async () => {
    // The ids in removeLineIds are unverified client input. The DELETE is
    // scoped to the order, so the victim's ROW always survived — but the sweep
    // read its keys off the raw id list, so the object behind that surviving
    // row was deleted out of R2 and the thumbnail 404'd for good.
    const { token } = await loginAs(ALEX);
    const mine = await poWithPhoto(token, 'SWEEP-MINE');
    const victim = await poWithPhoto(token, 'SWEEP-VICTIM');

    const r = await api('PATCH', '/api/orders/' + mine.id, {
      token,
      body: { removeLineIds: [victim.lineId] },
    });
    expect(r.status).toBe(200);
    expect(swept).not.toContain(victim.storageKey);

    // And the row it belongs to is untouched, so nothing would have replaced it.
    const left = await getTestDb()`
      SELECT 1 FROM order_line_photos WHERE order_line_id = ${victim.lineId}::uuid
    `;
    expect(left).toHaveLength(1);
  });
});

// scan_image_id is not owned by the line that carries it: a partial transfer
// clones the key onto a second line in the same order. The sweep read it
// straight off the doomed rows, so removing one of the pair deleted the object
// the survivor still renders — a 404 thumbnail with nothing left to restore.
describe('PATCH removeLineIds — a scan image shared with a transfer clone', () => {
  beforeEach(async () => { await resetDb(); swept.length = 0; });

  const withSharedScan = async (token: string, tag: string) => {
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        lines: [
          { category: 'RAM', brand: 'Samsung', capacity: '32GB', partNumber: tag + '-A', condition: 'New', qty: 2, unitCost: 50 },
          { category: 'RAM', brand: 'Samsung', capacity: '16GB', partNumber: tag + '-B', condition: 'New', qty: 1, unitCost: 25 },
        ],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const db = getTestDb();
    const rows = await db<{ id: string }[]>`
      SELECT id FROM order_lines WHERE order_id = ${id} ORDER BY position
    `;
    const key = `scans/${tag}-shared.png`;
    // What a partial transfer leaves behind: two lines, one key.
    await db`UPDATE order_lines SET scan_image_id = ${key} WHERE id = ${rows[0].id}::uuid`;
    const [clone] = await db<{ id: string }[]>`
      INSERT INTO order_lines (order_id, category, brand, capacity, part_number, condition,
                               qty, unit_cost, status, scan_image_id, position)
      VALUES (${id}, 'RAM', 'Samsung', '32GB', ${tag + '-A'}, 'New',
              1, 50, 'In Transit', ${key}, 9)
      RETURNING id
    `;
    return { id, sourceId: rows[0].id, cloneId: clone.id, key };
  };

  it('keeps the object while the clone still points at it', async () => {
    const { token } = await loginAs(ALEX);
    const { id, sourceId, key } = await withSharedScan(token, 'SWEEP-CLONE');

    const r = await api('PATCH', '/api/orders/' + id, { token, body: { removeLineIds: [sourceId] } });
    expect(r.status).toBe(200);
    expect(swept).not.toContain(key);
  });

  it('deletes it once the last line carrying it is gone', async () => {
    const { token } = await loginAs(ALEX);
    const { id, sourceId, cloneId, key } = await withSharedScan(token, 'SWEEP-LAST');

    const r = await api('PATCH', '/api/orders/' + id, {
      token, body: { removeLineIds: [sourceId, cloneId] },
    });
    expect(r.status).toBe(200);
    expect(swept).toContain(key);
  });
});
