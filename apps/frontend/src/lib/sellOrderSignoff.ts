import type { SellOrderSignoff } from './types';

// What a manager's sign-off approves, read the way the backend's
// orderFingerprint (services/sellOrderSignoff.ts) reads it, so the edit page
// knows which unsaved changes will void the sign-offs: a line's item, qty,
// native price or lot, the customer or the currency do; reordering lines or
// moving a lot between warehouses doesn't. Keep the two field sets alike.
export type SignoffLine = {
  inventoryId: string | null;
  category: string;
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  condition: string | null;
  qty: number;
  unitPrice: number;   // native (order-currency)
};

export function signoffSig(lines: readonly SignoffLine[], customerId: string, currency: string): string {
  const rows = lines.map(l => JSON.stringify([
    l.category, l.label, l.subLabel ?? null, l.partNumber ?? null, l.condition ?? null, l.qty,
    Math.round(l.unitPrice * 100) / 100,
    l.qty > 0 ? l.inventoryId : null,
  ])).sort();
  return JSON.stringify([customerId, currency, rows]);
}

export function missingSigners(signoff: SellOrderSignoff): string[] {
  return signoff.managers.filter(m => m.required && (m.signedAt === null || m.stale)).map(m => m.name);
}
