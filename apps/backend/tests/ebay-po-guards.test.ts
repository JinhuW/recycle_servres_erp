// A lot on an active eBay listing is held the way a committed sell order holds
// it: the PO can't take it back out of stock, delete it or archive it, and a
// move back to Reviewing leaves it Done and view-only.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, EBAY } from './helpers/auth';

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000002', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [
    { category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40, partNumber: 'EBAY-A' },
    { category: 'RAM', qty: 3, unitCost: 20, condition: 'New', sellPrice: 50, partNumber: 'EBAY-B' },
  ],
};

type Line = { id: string; status: string; partNumber: string; unitCost: number; shippedOn?: string[] };
type Refusal = { error: string; offendingLineIds: string[]; sellOrderIds: string[]; ebayListingIds: string[] };

async function advance(token: string, id: string, toStage?: string) {
  return api<Refusal & { lifecycle?: string }>('POST', `/api/orders/${id}/advance`, {
    token, body: toStage ? { toStage } : {},
  });
}

async function linesOf(token: string, id: string): Promise<Line[]> {
  return (await api<{ order: { lines: Line[] } }>('GET', `/api/orders/${id}`, { token })).body.order.lines;
}

// Marcus's two-line PO at `stage`, with one unit of line A on an eBay listing.
async function listedOrder(stage: 'reviewing' | 'ready_to_pay') {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await advance(marcus.token, id)).status).toBe(200);
  expect((await advance(alex.token, id)).status).toBe(200);
  if (stage === 'ready_to_pay') expect((await advance(alex.token, id)).status).toBe(200);
  const lines = await linesOf(alex.token, id);
  const a = lines.find(l => l.partNumber === 'EBAY-A')!;
  const b = lines.find(l => l.partNumber === 'EBAY-B')!;
  const listing = await api<{ ids: string[] }>('POST', '/api/ebay/listings', {
    token: alex.token, body: { inventoryId: a.id, listings: [{ qty: 1, listPrice: 40 }] },
  });
  expect(listing.status).toBe(201);
  return { id, alex, a, b, listingId: listing.body.ids[0] };
}

describe('PO guards for lots on eBay', () => {
  beforeEach(async () => { await resetDb(); });

  it('a move back out of stock is refused, naming the listing, as a committed sell order is', async () => {
    const { id, alex, a, listingId } = await listedOrder('ready_to_pay');
    const r = await advance(alex.token, id, 'in_transit');
    expect(r.status).toBe(409);
    expect(r.body.offendingLineIds).toEqual([a.id.toLowerCase()]);
    expect(r.body.ebayListingIds).toEqual([listingId]);
    expect(r.body.sellOrderIds).toEqual([]);
    expect(r.body.error).toContain(`eBay listing ${listingId}`);
  });

  it('a move back to Reviewing leaves the listed lot Done and view-only', async () => {
    const { id, alex, a, b, listingId } = await listedOrder('ready_to_pay');
    const back = await advance(alex.token, id, 'reviewing');
    expect(back.status).toBe(200);
    const lines = await linesOf(alex.token, id);
    expect(lines.find(l => l.id === a.id)!.status).toBe('Done');
    expect(lines.find(l => l.id === a.id)!.shippedOn).toEqual([listingId]);
    expect(lines.find(l => l.id === b.id)!.status).toBe('Reviewing');

    const edit = await api<Refusal>('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { lines: [{ id: a.id, unitCost: 11 }] },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.ebayListingIds).toEqual([listingId]);
    expect(edit.body.sellOrderIds).toEqual([]);

    // Once the listing ends the hold lifts.
    const { token: op } = await loginAs(EBAY);
    expect((await api('POST', `/api/ebay/listings/${listingId}/end`, { token: op, body: { reason: 'no_buyer' } })).status).toBe(200);
    expect((await linesOf(alex.token, id)).find(l => l.id === a.id)!).not.toHaveProperty('shippedOn');
  });

  it('removing a listed lot is refused; an ended listing lets it go and keeps its record', async () => {
    const { id, alex, a, listingId } = await listedOrder('reviewing');
    const r = await api<Refusal>('PATCH', `/api/orders/${id}`, { token: alex.token, body: { removeLineIds: [a.id] } });
    expect(r.status).toBe(409);
    expect(r.body.offendingLineIds).toEqual([a.id]);
    expect(r.body.ebayListingIds).toEqual([listingId]);
    expect(r.body.sellOrderIds).toEqual([]);

    expect((await api('POST', `/api/ebay/listings/${listingId}/end`, {
      token: alex.token, body: { reason: 'cancelled' },
    })).status).toBe(200);
    expect((await api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { removeLineIds: [a.id] } })).status).toBe(200);
    const [row] = await getTestDb()<{ inventory_id: string | null; status: string }[]>`
      SELECT inventory_id, status FROM ebay_listings WHERE id = ${listingId}`;
    expect(row).toEqual({ inventory_id: null, status: 'Ended' });
  });

  it('a qty edit below what the listing holds names the listing under its own key', async () => {
    const { id, alex, a, listingId } = await listedOrder('reviewing');
    const r = await api<Refusal>('PATCH', `/api/orders/${id}`, { token: alex.token, body: { lines: [{ id: a.id, qty: 0 }] } });
    expect(r.status).toBe(409);
    expect(r.body.sellOrderIds).toEqual([]);
    expect(r.body.ebayListingIds).toEqual([listingId]);
  });

  it('archiving the PO is refused while a lot is listed', async () => {
    const { id, alex, a, listingId } = await listedOrder('ready_to_pay');
    const r = await api<Refusal>('POST', `/api/orders/${id}/archive`, { token: alex.token, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.offendingLineIds).toEqual([a.id]);
    expect(r.body.ebayListingIds).toEqual([listingId]);
  });
});
