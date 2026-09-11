import { ApiError } from './api';

// What POST /api/orders/:id/archive refuses with when the order's goods sit on
// open sell orders: the user decides whether to pull them off those orders.
export type ArchiveConflictSellOrder = {
  id: string;
  status: string;
  // solId is the sell-order line, which is what tells two entries for the
  // same lot apart; inventoryId is what the label falls back to.
  lines: { solId: string; inventoryId: string; label: string; qty: number }[];
  // Every line the sell order holds is one of these, so the removal leaves it
  // with nothing on it.
  emptied: boolean;
};

export type ArchiveConflict = { sellOrders: ArchiveConflictSellOrder[] };

// Only this one 409 is a question rather than a refusal — "already archived"
// and the transfer-order block are 409s too, told apart by `code`.
export function readArchiveConflict(err: unknown): ArchiveConflict | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { code?: unknown; sellOrders?: unknown } | null | undefined;
  if (!body || body.code !== 'committedLines' || !Array.isArray(body.sellOrders)) return null;
  const sellOrders: ArchiveConflictSellOrder[] = [];
  for (const so of body.sellOrders as Array<Record<string, unknown>>) {
    if (typeof so?.id !== 'string' || !Array.isArray(so.lines)) continue;
    const lines = (so.lines as Array<Record<string, unknown>>).map((l, i) => ({
      solId: typeof l.solId === 'string' ? l.solId : String(i),
      inventoryId: String(l.inventoryId ?? ''),
      label: typeof l.label === 'string' ? l.label : '',
      qty: typeof l.qty === 'number' ? l.qty : 0,
    }));
    sellOrders.push({
      id: so.id,
      status: typeof so.status === 'string' ? so.status : '',
      lines,
      emptied: typeof so.lineCount === 'number' && lines.length >= so.lineCount,
    });
  }
  return sellOrders.length ? { sellOrders } : null;
}
