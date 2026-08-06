import { describe, it, expect, beforeEach } from 'vitest';
import sharp from 'sharp';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

// Any purchase-order line may carry photos of the goods. Distinct from the
// order-level Submission receipt and from the AI label scan (which only RAM
// lines ever get, and only by going through OCR).

type Photo = { id: string; url: string; source: 'scan' | 'upload'; filename: string | null };
type Line = { id: string; category: string; photos: Photo[] };

async function png(width = 8, height = 8): Promise<File> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 110, b: 76 } },
  }).png().toBuffer();
  return new File([new Uint8Array(buf)], 'dimm.png', { type: 'image/png' });
}

async function makePo(token: string, category = 'RAM'): Promise<{ id: string; lineId: string }> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      lines: [{
        category,
        ...(category === 'Other'
          ? { itemType: 'Riser card', description: 'Dell R740 riser' }
          : { brand: 'Samsung', capacity: '32GB' }),
        partNumber: 'PHOTO-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(r.status).toBe(201);
  const d = await api<{ order: { lines: Line[] } }>('GET', '/api/orders/' + r.body.id, { token });
  return { id: r.body.id, lineId: d.body.order.lines[0].id };
}

const lines = async (token: string, id: string) =>
  (await api<{ order: { lines: Line[] } }>('GET', '/api/orders/' + id, { token })).body.order.lines;

describe('POST /api/orders/:id/lines/:lineId/photos', () => {
  beforeEach(async () => { await resetDb(); });

  it('attaches a photo to a non-RAM line and returns it on the order', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token, 'Other');

    const r = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token });
    expect(r.status).toBe(200);

    const [line] = await lines(token, id);
    expect(line.photos).toHaveLength(1);
    expect(line.photos[0].source).toBe('upload');
    expect(line.photos[0].filename).toBe('dimm.png');
  });

  it('keeps photos in upload order', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    for (let i = 0; i < 3; i++) {
      await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png(8 + i) }, { token });
    }
    const db = getTestDb();
    const rows = await db<{ position: number }[]>`
      SELECT position FROM order_line_photos WHERE order_line_id = ${lineId}::uuid ORDER BY position
    `;
    expect(rows.map(r => r.position)).toEqual([0, 1, 2]);
  });

  it('404s a line that belongs to another order', async () => {
    const { token } = await loginAs(ALEX);
    const a = await makePo(token);
    const b = await makePo(token);
    const r = await multipart(`/api/orders/${a.id}/lines/${b.lineId}/photos`, { file: await png() }, { token });
    expect(r.status).toBe(404);
  });

  it('404s a malformed line id rather than throwing', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await makePo(token);
    const r = await multipart(`/api/orders/${id}/lines/not-a-uuid/photos`, { file: await png() }, { token });
    expect(r.status).toBe(404);
  });

  it('rejects a non-image with 415', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'receipt.pdf', { type: 'application/pdf' });
    const r = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: pdf }, { token });
    expect(r.status).toBe(415);
  });

  it('caps the number of photos per line', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    for (let i = 0; i < 6; i++) {
      const ok = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png(8 + i) }, { token });
      expect(ok.status).toBe(200);
    }
    const over = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png(20) }, { token });
    expect(over.status).toBe(409);
  });

  it('lets the owning purchaser attach, and refuses a stranger', async () => {
    const mine = await loginAs(MARCUS);
    const { id, lineId } = await makePo(mine.token);

    const own = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token: mine.token });
    expect(own.status).toBe(200);

    const other = await loginAs(PRIYA);
    const r = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token: other.token });
    // A purchaser can't even see another's PO, so this is a 404 before authz.
    expect([403, 404]).toContain(r.status);
  });

  it('refuses the purchaser once the order is Done, but not a manager', async () => {
    const mine = await loginAs(MARCUS);
    const { id, lineId } = await makePo(mine.token);
    const db = getTestDb();
    await db`UPDATE orders SET lifecycle = 'done' WHERE id = ${id}`;

    const purchaser = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token: mine.token });
    expect(purchaser.status).toBe(403);

    const mgr = await loginAs(ALEX);
    const asManager = await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token: mgr.token });
    expect(asManager.status).toBe(200);
  });

  it('records the upload in the change log', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token });

    const ev = await api<{ events: { kind: string; detail: Record<string, unknown> }[] }>(
      'GET', `/api/orders/${id}/events`, { token },
    );
    const added = ev.body.events.find(e => e.kind === 'line_photo_added');
    expect(added?.detail).toMatchObject({ lineId, filename: 'dimm.png' });
  });
});

describe('DELETE /api/orders/:id/lines/:lineId/photos/:photoId', () => {
  beforeEach(async () => { await resetDb(); });

  it('removes the row and logs it', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    const up = await multipart<{ photo: Photo }>(
      `/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token },
    );
    const photoId = up.body.photo.id;

    const del = await api('DELETE', `/api/orders/${id}/lines/${lineId}/photos/${photoId}`, { token });
    expect(del.status).toBe(200);
    expect((await lines(token, id))[0].photos).toHaveLength(0);

    const ev = await api<{ events: { kind: string }[] }>('GET', `/api/orders/${id}/events`, { token });
    expect(ev.body.events.some(e => e.kind === 'line_photo_removed')).toBe(true);
  });

  it('refuses to delete a scan-sourced photo through this route', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    const r = await api('DELETE', `/api/orders/${id}/lines/${lineId}/photos/scan:some-key`, { token });
    expect(r.status).toBe(404);
  });
});

describe('line photos and the line lifecycle', () => {
  beforeEach(async () => { await resetDb(); });

  it('cascades when the line is removed', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token });

    // A PO must keep at least one line, so add a second before removing the first.
    await api('PATCH', '/api/orders/' + id, {
      token,
      body: { addLines: [{ category: 'SSD', brand: 'Intel', partNumber: 'X', condition: 'New', qty: 1, unitCost: 1 }] },
    });
    const r = await api('PATCH', '/api/orders/' + id, { token, body: { removeLineIds: [lineId] } });
    expect(r.status).toBe(200);

    const db = getTestDb();
    const left = await db`SELECT 1 FROM order_line_photos WHERE order_line_id = ${lineId}::uuid`;
    expect(left).toHaveLength(0);
  });

  it('cascades when the whole draft order is deleted', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await makePo(token);
    await multipart(`/api/orders/${id}/lines/${lineId}/photos`, { file: await png() }, { token });

    const r = await api('DELETE', '/api/orders/' + id, { token });
    expect(r.status).toBe(200);

    const db = getTestDb();
    expect(await db`SELECT 1 FROM order_line_photos WHERE order_id = ${id}`).toHaveLength(0);
  });
});
