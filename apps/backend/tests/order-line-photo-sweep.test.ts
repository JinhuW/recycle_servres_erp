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
