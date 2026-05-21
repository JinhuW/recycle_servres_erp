import { api } from './app';

export type SellableLine = { id: string; qty: number; unit_cost: number; sell_price: number };

// Find a Reviewing inventory line that is sellable AND not already committed to
// an open (non-Done) sell order. The seed legitimately attaches its first 36
// sellable lines to seeded sell orders, and the one-active-sell-order-per-line
// invariant rejects a second open order on the same line — so tests that build
// a fresh sell order must start from a genuinely free line.
export async function freeSellableLine(token: string, minQty = 1): Promise<SellableLine> {
  const r = await api<{ items: Array<{ id: string; status: string; qty: number; unit_cost: number; sell_price: number | null }> }>(
    'GET', '/api/inventory?status=Reviewing', { token });
  const candidates = r.body.items.filter(i => i.sell_price != null && i.qty >= minQty);
  for (const c of candidates) {
    const so = await api<{ items: { status: string }[] }>(
      'GET', `/api/inventory/${c.id}/sell-orders`, { token });
    const onOpenOrder = so.body.items.some(s => s.status !== 'Done');
    if (!onOpenOrder) {
      return { id: c.id, qty: c.qty, unit_cost: c.unit_cost, sell_price: c.sell_price as number };
    }
  }
  throw new Error(`no free sellable line (qty >= ${minQty}) in seed`);
}
