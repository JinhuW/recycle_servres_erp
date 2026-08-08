import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// The object goes into R2 before the transaction that would own it opens, so
// every rollback leaves one behind. Nothing finds it later: both cleanup paths
// (DELETE /orders/:id and the removeLineIds sweep) read their keys out of
// order_line_photos, and that row is exactly what didn't commit.
//
// The photo cap was the only rollback the route cleaned up after. This forces a
// different one — the audit write — to pin the rule as "any failure", not "the
// failure we happened to think of".
const { swept, boom } = vi.hoisted(() => ({ swept: [] as string[], boom: { armed: false } }));

vi.mock('../src/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/r2')>();
  return {
    ...actual,
    deleteAttachment: async (_env: unknown, key: string) => { swept.push(key); },
    // The rollback path uses the single-key form, but the batch one is watched
    // too so a future move to it cannot make these assertions vacuous.
    deleteAttachments: async (_env: unknown, keys: readonly string[]) => {
      swept.push(...keys);
      return [];
    },
  };
});

vi.mock('../src/services/orderAudit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/orderAudit')>();
  return {
    ...actual,
    writeOrderEvent: async (...args: Parameters<typeof actual.writeOrderEvent>) => {
      if (boom.armed && args[3] === 'line_photo_added') throw new Error('audit write failed');
      return actual.writeOrderEvent(...args);
    },
  };
});

async function png(): Promise<File> {
  const buf = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 110, b: 76 } },
  }).png().toBuffer();
  return new File([new Uint8Array(buf)], 'dimm.png', { type: 'image/png' });
}

describe('POST line photo — a rolled-back upload leaves nothing in R2', () => {
  beforeEach(async () => { await resetDb(); swept.length = 0; boom.armed = false; });

  it('drops the uploaded object when the transaction fails for any reason', async () => {
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', partNumber: 'ORPHAN-1',
          condition: 'New', qty: 1, unitCost: 10,
        }],
      },
    });
    const id = created.body.id;
    const detail = await api<{ order: { lines: { id: string }[] } }>('GET', '/api/orders/' + id, { token });
    const lineId = detail.body.order.lines[0].id;

    boom.armed = true;
    const r = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token });
    expect(r.status).toBe(500);

    // Nothing committed…
    expect(await getTestDb()`
      SELECT 1 FROM order_line_photos WHERE order_line_id = ${lineId}::uuid
    `).toHaveLength(0);
    // …so nothing may be left in the bucket either.
    expect(swept).toHaveLength(1);
  });
});
