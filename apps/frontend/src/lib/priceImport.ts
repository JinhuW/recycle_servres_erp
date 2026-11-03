// Applies confirmed vendor prices from a price-import preview onto the edit
// form's draft lines. Matching repeats the backend's rule — canonical part
// number, every condition of the part alike — against the *live* draft, so
// lines the manager added or removed after the preview still resolve
// correctly.

import { canonicalPartNumber } from './format';

export type PriceApplyLine = {
  partNumber: string | null;
  unitPrice: number;
};

export type PriceApplyRow = {
  canonPart: string;
  price: number;
};

export function applyPriceRows<L extends PriceApplyLine>(
  lines: L[],
  rows: PriceApplyRow[],
): L[] {
  return lines.map(line => {
    const canon = canonicalPartNumber(line.partNumber);
    if (canon === '') return line;
    const row = rows.find(r => r.canonPart === canon);
    return row ? { ...line, unitPrice: row.price } : line;
  });
}

export type MarketSyncLine = {
  partNumber: string | null;
  label: string;
  qty: number;
  nativeUnitPrice: number;
};

export type MarketSyncPart = {
  canonPart: string;
  partNumber: string;
  label: string;
  qty: number;
  // Qty-weighted across the part's lines, the same way the backend records it.
  price: number;
  lineCount: number;
};

// What Sync to Market can offer: a part per canonical part number, leaving out
// lines at qty 0 and a part with no price, which the backend would not record.
export function marketSyncParts(lines: MarketSyncLine[]): MarketSyncPart[] {
  const byCanon = new Map<string, MarketSyncPart & { priceQty: number }>();
  for (const l of lines) {
    const canon = canonicalPartNumber(l.partNumber);
    if (canon === '' || l.qty <= 0) continue;
    const part = byCanon.get(canon)
      ?? { canonPart: canon, partNumber: l.partNumber ?? '', label: l.label, qty: 0, price: 0, lineCount: 0, priceQty: 0 };
    part.qty += l.qty;
    part.priceQty += l.nativeUnitPrice * l.qty;
    part.lineCount += 1;
    byCanon.set(canon, part);
  }
  return [...byCanon.values()]
    .filter(p => p.priceQty > 0)
    .map(({ priceQty, ...p }) => ({ ...p, price: priceQty / p.qty }));
}
