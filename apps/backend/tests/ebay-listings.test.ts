import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, EBAY } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { signOffAll } from './helpers/fixtures';

type Created = { ids: string[] };

// What the sell-order picker offers of a lot: absent means nothing.
async function pickerQty(token: string, lineId: string): Promise<number> {
  const [{ part_number: pn }] = await getTestDb()<{ part_number: string | null }[]>`
    SELECT part_number FROM order_lines WHERE id = ${lineId}`;
  const r = await api<{ items: { inventoryId: string; availableQty: number }[] }>(
    'GET', `/api/sell-orders/sellable?q=${encodeURIComponent(pn ?? '')}`, { token });
  expect(r.status).toBe(200);
  return r.body.items.find(i => i.inventoryId === lineId)?.availableQty ?? 0;
}

async function list(
  token: string, inventoryId: string, listings: { qty: number; listPrice: number; spec?: string }[],
) {
  return api<Created & { error?: string }>('POST', '/api/ebay/listings', {
    token, body: { inventoryId, note: 'please post', listings },
  });
}

async function linkItem(token: string, id: string, itemId: string) {
  const r = await api<{ status: string }>('PATCH', `/api/ebay/listings/${id}`, { token, body: { ebayItemId: itemId } });
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('Listed');
}

async function markSold(token: string, id: string, qty: number, extra: Record<string, unknown> = {}) {
  return api<{ sellOrderId: string; listingStatus: string; remaining: number; saleId: string; error?: string }>(
    'POST', `/api/ebay/listings/${id}/sales`, { token, body: { qty, unitPrice: 39, ...extra } });
}

describe('eBay listings', () => {
  beforeEach(async () => { await resetDb(); });

  it('a listing reserves its qty; over-listing is a 400', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 4);
    const before = await pickerQty(token, line.id);
    expect(before).toBe(line.qty);

    const r = await list(token, line.id, [{ qty: 3, listPrice: 45 }]);
    expect(r.status).toBe(201);
    expect(r.body.ids).toHaveLength(1);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 3);

    const over = await list(token, line.id, [{ qty: line.qty - 2, listPrice: 45 }]);
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/only \d+ of .* are free/);

    // A sell order can't take what the listing holds either.
    const [{ id: customerId }] = await getTestDb()<{ id: string }[]>`SELECT id FROM customers WHERE name <> 'eBay' LIMIT 1`;
    const so = await api<{ error: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', qty: line.qty, unitPrice: 1 }] },
    });
    expect(so.status).toBe(400);
    expect(so.body.error).toContain(`eBay listing ${r.body.ids[0]}`);
  });

  it('several listings from one lot in one request, all or none', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 4);
    const tooMany = await list(token, line.id, [
      { qty: line.qty - 1, listPrice: 30, spec: '16GB' }, { qty: 2, listPrice: 60, spec: '32GB' },
    ]);
    expect(tooMany.status).toBe(400);
    expect((await getTestDb()`SELECT 1 FROM ebay_listings WHERE inventory_id = ${line.id}`).length).toBe(0);

    const ok = await list(token, line.id, [
      { qty: 1, listPrice: 30, spec: '16GB 2Rx8' }, { qty: 2, listPrice: 60, spec: '32GB 2Rx4' },
    ]);
    expect(ok.status).toBe(201);
    expect(ok.body.ids).toHaveLength(2);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 3);

    // The listing names its lot and the lot's other listings, and carries no cost.
    const { token: op } = await loginAs(EBAY);
    const d = await api<{ listing: Record<string, unknown> & {
      spec: string; lot: { inventoryId: string; productNo: number; otherListings: { id: string; spec: string }[] };
    } }>('GET', `/api/ebay/listings/${ok.body.ids[0]}`, { token: op });
    expect(d.status).toBe(200);
    expect(d.body.listing.spec).toBe('16GB 2Rx8');
    expect(d.body.listing.lot.inventoryId).toBe(line.id);
    expect(typeof d.body.listing.lot.productNo).toBe('number');
    expect(d.body.listing.lot.otherListings).toEqual([
      expect.objectContaining({ id: ok.body.ids[1], spec: '32GB 2Rx4', status: 'Queued', qty: 2 }),
    ]);
    expect(JSON.stringify(d.body)).not.toMatch(/unit_cost|unitCost|supplier|purchaser|total_cost/i);

    // The lot page lists both.
    const lot = await api<{ items: { id: string }[] }>('GET', `/api/inventory/${line.id}/ebay-listings`, { token });
    expect(lot.body.items.map(i => i.id).sort()).toEqual([...ok.body.ids].sort());

    // And the eBay operator can't create listings.
    expect((await list(op, line.id, [{ qty: 1, listPrice: 1 }])).status).toBe(403);
  });

  it('a partial sale raises an Awaiting-payment sell order to eBay; the last unit marks it Sold', async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 4);
    const { body: { ids: [id] } } = await list(token, line.id, [{ qty: 3, listPrice: 45 }]);

    // Not on eBay yet: no sale can be recorded.
    expect((await markSold(op, id, 1)).status).toBe(409);
    await linkItem(op, id, '255012345671');

    const sale = await markSold(op, id, 2, { ebayOrderId: '12-04129-88231', fees: 6.12, buyer: 'k***r' });
    expect(sale.status).toBe(201);
    expect(sale.body.listingStatus).toBe('Listed');
    expect(sale.body.remaining).toBe(1);

    const sql = getTestDb();
    const [so] = await sql<{ status: string; customer: string; notes: string }[]>`
      SELECT so.status, c.name AS customer, so.notes FROM sell_orders so JOIN customers c ON c.id = so.customer_id
      WHERE so.id = ${sale.body.sellOrderId}`;
    expect(so.status).toBe('Awaiting payment');
    expect(so.customer).toBe('eBay');
    expect(so.notes).toContain('12-04129-88231');
    expect(so.notes).toContain('fees $6.12');
    const [sol] = await sql<{ inventory_id: string; qty: number; unit_price: number }[]>`
      SELECT inventory_id, qty, unit_price::float AS unit_price FROM sell_order_lines WHERE sell_order_id = ${sale.body.sellOrderId}`;
    expect(sol).toEqual({ inventory_id: line.id, qty: 2, unit_price: 39 });
    const soEvents = await sql<{ kind: string }[]>`
      SELECT kind FROM sell_order_events WHERE sell_order_id = ${sale.body.sellOrderId} ORDER BY created_at, id`;
    expect(soEvents.map(e => e.kind).sort()).toEqual(['created', 'status_changed']);

    // 2 on the sell order + 1 left on the listing, never 2 twice.
    expect(await pickerQty(token, line.id)).toBe(line.qty - 3);

    expect((await markSold(op, id, 2)).status).toBe(409);
    const last = await markSold(op, id, 1);
    expect(last.status).toBe(201);
    expect(last.body.listingStatus).toBe('Sold');
    expect(await pickerQty(token, line.id)).toBe(line.qty - 3);

    const events = await sql<{ kind: string }[]>`
      SELECT kind FROM ebay_listing_events WHERE listing_id = ${id} ORDER BY created_at, id`;
    // One transaction's events share its timestamp, so compare as a set.
    expect(events.map(e => e.kind).sort()).toEqual(
      ['created', 'edited', 'listed', 'sale_confirmed', 'sale_confirmed', 'sold'].sort());
    // Append-only.
    await expect(sql`UPDATE ebay_listing_events SET note = 'x' WHERE listing_id = ${id}`).rejects.toThrow(/append-only/);

    // Done consumes the lot through the ordinary sell-order path.
    await signOffAll(sale.body.sellOrderId);
    const done = await api('POST', `/api/sell-orders/${sale.body.sellOrderId}/status`, { token, body: { to: 'Done' } });
    expect(done.status).toBe(200);
    const [after] = await sql<{ qty: number }[]>`SELECT qty FROM order_lines WHERE id = ${line.id}`;
    expect(after.qty).toBe(line.qty - 2);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 3);
  });

  it('ending a listing gives its remainder back to stock', async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 4);
    const { body: { ids: [id] } } = await list(token, line.id, [{ qty: 3, listPrice: 45 }]);
    await linkItem(op, id, '255012345672');
    expect((await markSold(op, id, 1)).status).toBe(201);

    // Only a manager cancels, and only before it is posted.
    expect((await api('POST', `/api/ebay/listings/${id}/end`, { token: op, body: { reason: 'cancelled' } })).status).toBe(403);
    expect((await api('POST', `/api/ebay/listings/${id}/end`, { token, body: { reason: 'cancelled' } })).status).toBe(409);

    const r = await api<{ returnedQty: number }>('POST', `/api/ebay/listings/${id}/end`, {
      token: op, body: { reason: 'no_buyer', note: '44 days, no bites' },
    });
    expect(r.status).toBe(200);
    expect(r.body.returnedQty).toBe(2);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 1);
    expect((await api('POST', `/api/ebay/listings/${id}/end`, { token: op, body: { reason: 'no_buyer' } })).status).toBe(409);

    const inv = await getTestDb()<{ kind: string; detail: Record<string, unknown> }[]>`
      SELECT kind, detail FROM inventory_events WHERE order_line_id = ${line.id} AND kind LIKE 'ebay_%'
      ORDER BY created_at, id`;
    expect(inv.map(e => e.kind)).toEqual(['ebay_listed', 'ebay_ended']);
    expect(inv[1].detail).toMatchObject({ listing: id, returnedQty: 2, reason: 'no_buyer' });
  });

  it('a manager cancels a Queued listing', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const { body: { ids: [id] } } = await list(token, line.id, [{ qty: 2, listPrice: 10 }]);
    const r = await api('POST', `/api/ebay/listings/${id}/end`, { token, body: { reason: 'cancelled' } });
    expect(r.status).toBe(200);
    expect(await pickerQty(token, line.id)).toBe(line.qty);
  });

  it('reservation is per lot: two listings, a sale on one, the other ended', async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 5);
    const { body: { ids: [a, b] } } = await list(token, line.id, [
      { qty: 2, listPrice: 30, spec: '16GB' }, { qty: 3, listPrice: 60, spec: '32GB' },
    ]);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 5);

    await linkItem(op, a, '255012345673');
    const sale = await markSold(op, a, 1);
    expect(sale.status).toBe(201);
    // 1 on the sell order, 1 left on A, 3 on B.
    expect(await pickerQty(token, line.id)).toBe(line.qty - 5);

    expect((await api('POST', `/api/ebay/listings/${b}/end`, { token: op, body: { reason: 'damaged' } })).status).toBe(200);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 2);

    const listing = await api<{ rows: { id: string }[]; counts: Record<string, number> }>(
      'GET', '/api/ebay/listings?status=Listed', { token: op });
    expect(listing.body.rows.map(r => r.id)).toEqual([a]);
    expect(listing.body.counts).toMatchObject({ Listed: 1, Ended: 1, Queued: 0, Sold: 0, ToConfirm: 0 });
  });

  it('split a Queued listing into the items it really is', async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 4);
    const { body: { ids: [id] } } = await list(token, line.id, [{ qty: 4, listPrice: 40 }]);

    const bad = await api('POST', `/api/ebay/listings/${id}/split`, {
      token: op, body: { parts: [{ qty: 1, listPrice: 30 }, { qty: 2, listPrice: 60 }] },
    });
    expect(bad.status).toBe(400);

    const r = await api<{ newIds: string[] }>('POST', `/api/ebay/listings/${id}/split`, {
      token: op,
      body: { parts: [
        { qty: 1, listPrice: 30, spec: '16GB' }, { qty: 2, listPrice: 60, spec: '32GB' },
        { qty: 1, listPrice: 25, spec: '8GB' },
      ] },
    });
    expect(r.status).toBe(201);
    expect(r.body.newIds).toHaveLength(2);
    const rows = await getTestDb()<{ id: string; qty: number; spec: string; list_price: number }[]>`
      SELECT id, qty, spec, list_price::float AS list_price FROM ebay_listings
      WHERE inventory_id = ${line.id} ORDER BY id`;
    expect(rows.map(x => [x.qty, x.spec, x.list_price])).toEqual([[1, '16GB', 30], [2, '32GB', 60], [1, '8GB', 25]]);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 4);

    const ev = await getTestDb()<{ listing_id: string; kind: string }[]>`
      SELECT listing_id, kind FROM ebay_listing_events WHERE listing_id = ANY(${rows.map(x => x.id)}) ORDER BY created_at, id`;
    expect(ev.filter(e => e.listing_id === id).map(e => e.kind).sort()).toEqual(['created', 'edited']);
    for (const n of r.body.newIds) expect(ev.filter(e => e.listing_id === n).map(e => e.kind)).toEqual(['created']);

    // Only while it is still to post.
    await linkItem(op, id, '255012345674');
    const late = await api('POST', `/api/ebay/listings/${id}/split`, {
      token: op, body: { parts: [{ qty: 0, listPrice: 1 }, { qty: 1, listPrice: 1 }] },
    });
    expect(late.status).toBe(400);
    const late2 = await api('POST', `/api/ebay/listings/${id}/split`, { token: op, body: { parts: [{ qty: 1, listPrice: 1 }, { qty: 1, listPrice: 1 }] } });
    expect(late2.status).toBe(409);
  });

  it('a detected sale is confirmed once, or dismissed', async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 3);
    const { body: { ids: [id] } } = await list(token, line.id, [{ qty: 3, listPrice: 45 }]);
    await linkItem(op, id, '255012345675');
    const sql = getTestDb();
    // What the eBay sync will insert.
    const [s1, s2] = await sql<{ id: string }[]>`
      INSERT INTO ebay_sales (listing_id, qty, unit_price, fees, ebay_order_id, ebay_line_item_id, status)
      VALUES (${id}, 1, 44, 5.5, '12-1', 'L1', 'Detected'), (${id}, 1, 44, 5.5, '12-2', 'L2', 'Detected')
      RETURNING id`;
    const queue = await api<{ sales: { id: string; listing: { id: string; remaining: number } }[] }>(
      'GET', '/api/ebay/sales', { token: op });
    expect(queue.body.sales.map(s => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect((await api<{ counts: { ToConfirm: number } }>('GET', '/api/ebay/listings', { token: op })).body.counts.ToConfirm).toBe(2);
    // Nothing ends while sales wait on it.
    expect((await api('POST', `/api/ebay/listings/${id}/end`, { token: op, body: { reason: 'no_buyer' } })).status).toBe(409);

    const c1 = await api<{ sellOrderId: string }>('POST', `/api/ebay/sales/${s1.id}/confirm`, { token: op });
    expect(c1.status).toBe(200);
    expect(c1.body.sellOrderId).toMatch(/^SO-/);
    const again = await api('POST', `/api/ebay/sales/${s1.id}/confirm`, { token: op });
    expect(again.status).toBe(409);
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ebay_sales WHERE sell_order_id IS NOT NULL`;
    expect(n).toBe(1);

    expect((await api('POST', `/api/ebay/sales/${s2.id}/dismiss`, { token: op, body: { note: 'other listing' } })).status).toBe(200);
    expect((await api('POST', `/api/ebay/sales/${s2.id}/confirm`, { token: op })).status).toBe(409);
    expect(await pickerQty(token, line.id)).toBe(line.qty - 3);
  });

  it("the inventory list and grouped view carry each lot's eBay links, and filter on them", async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 3);
    const { body: { ids: [a, b, gone] } } = await list(token, line.id, [
      { qty: 1, listPrice: 30, spec: '16GB' }, { qty: 1, listPrice: 60, spec: '32GB' }, { qty: 1, listPrice: 1 },
    ]);
    await linkItem(op, a, '255012345677');
    expect((await api('POST', `/api/ebay/listings/${gone}/end`, { token: op, body: { reason: 'damaged' } })).status).toBe(200);

    type Link = { listingId: string; listingNo: string; spec: string | null; status: string; remaining: number;
      ebayItemId: string | null; ebayUrl: string | null };
    const flat = await api<{ items: { id: string; ebay: Link[] }[] }>('GET', '/api/inventory?status=Reviewing', { token });
    expect(flat.status).toBe(200);
    const row = flat.body.items.find(i => i.id === line.id)!;
    expect(row.ebay).toEqual([
      { listingId: a, listingNo: a, spec: '16GB', status: 'Listed', remaining: 1,
        ebayItemId: '255012345677', ebayUrl: 'https://www.ebay.com/itm/255012345677' },
      { listingId: b, listingNo: b, spec: '32GB', status: 'Queued', remaining: 1, ebayItemId: null, ebayUrl: null },
    ]);
    expect(flat.body.items.filter(i => i.id !== line.id).every(i => Array.isArray(i.ebay) && i.ebay.length === 0)).toBe(true);

    const listed = await api<{ items: { id: string }[] }>('GET', '/api/inventory?status=Reviewing&ebay=listed', { token });
    expect(listed.body.items.map(i => i.id)).toEqual([line.id]);
    const none = await api<{ items: { id: string }[] }>('GET', '/api/inventory?status=Reviewing&ebay=none', { token });
    expect(none.body.items.some(i => i.id === line.id)).toBe(false);
    expect(none.body.items.length).toBe(flat.body.items.length - 1);

    const grouped = await api<{ products: { lines: { id: string; ebay: Link[] }[] }[] }>(
      'GET', '/api/inventory/products?ebay=listed', { token });
    expect(grouped.status).toBe(200);
    const lots = grouped.body.products.flatMap(p => p.lines);
    expect(lots.map(l => l.id)).toEqual([line.id]);
    expect(lots[0].ebay.map(l => l.listingId)).toEqual([a, b]);
    const all = await api<{ products: { lines: { ebay: Link[] }[] }[] }>('GET', '/api/inventory/products', { token });
    expect(all.body.products.flatMap(p => p.lines).every(l => Array.isArray(l.ebay))).toBe(true);
  });

  it("the listing detail checks the lot's stock", async () => {
    const { token } = await loginAs(ALEX);
    const { token: op } = await loginAs(EBAY);
    const line = await freeSellableLine(token, 4);
    const { body: { ids: [a, b] } } = await list(token, line.id, [{ qty: 2, listPrice: 30 }, { qty: 1, listPrice: 30 }]);
    await linkItem(op, a, '255012345678');
    expect((await markSold(op, a, 1)).status).toBe(201);
    const d = await api<{ listing: { lot: { stock: Record<string, number> } } }>('GET', `/api/ebay/listings/${b}`, { token: op });
    expect(d.body.listing.lot.stock).toEqual({
      onHand: line.qty, heldForEbay: 2, heldForSellOrders: 1, sellable: line.qty - 3,
    });
  });

  it('a linked item # is unique across listings', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const { body: { ids: [a, b] } } = await list(token, line.id, [{ qty: 1, listPrice: 1 }, { qty: 1, listPrice: 1 }]);
    await linkItem(token, a, '255012345676');
    const r = await api<{ error: string }>('PATCH', `/api/ebay/listings/${b}`, { token, body: { ebayItemId: '255012345676' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(a);
  });
});
