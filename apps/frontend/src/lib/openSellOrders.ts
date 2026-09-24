// Sell orders that can still take more lines: the edit modal locks Done and
// Closed, and the list endpoint already leaves archived orders out.
export type SellOrderPick = {
  id: string;
  status: string;
  customer: { name: string; short: string | null };
  lineCount: number;
  qty: number;
  total: number;
  createdAt: string;
};

const LOCKED = new Set(['Done', 'Closed']);

export function openSellOrders<T extends SellOrderPick>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter(o => !LOCKED.has(o.status) && (
    q === ''
    || o.id.toLowerCase().includes(q)
    || o.customer.name.toLowerCase().includes(q)
    || (o.customer.short ?? '').toLowerCase().includes(q)
  ));
}
