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
  unitPrice: number; // USD, what the Market records
};

export type MarketSyncPart = {
  canonPart: string;
  partNumber: string;
  label: string;
  qty: number;
  // Qty-weighted across the part's priced lines, the same way the backend
  // records it: `price` in the order's currency, `usdPrice` in USD.
  price: number;
  usdPrice: number;
  lineCount: number;
};

// What Sync to Market can offer: a part per canonical part number, leaving out
// lines at qty 0 or priced at 0, which the backend would not count.
export function marketSyncParts(lines: MarketSyncLine[]): MarketSyncPart[] {
  const byCanon = new Map<string, MarketSyncPart & { priceQty: number; usdQty: number }>();
  for (const l of lines) {
    const canon = canonicalPartNumber(l.partNumber);
    if (canon === '' || l.qty <= 0 || l.unitPrice <= 0) continue;
    const part = byCanon.get(canon)
      ?? { canonPart: canon, partNumber: l.partNumber ?? '', label: l.label, qty: 0, price: 0, usdPrice: 0, lineCount: 0, priceQty: 0, usdQty: 0 };
    part.qty += l.qty;
    part.priceQty += l.nativeUnitPrice * l.qty;
    part.usdQty += l.unitPrice * l.qty;
    part.lineCount += 1;
    byCanon.set(canon, part);
  }
  return [...byCanon.values()].map(({ priceQty, usdQty, ...p }) => ({
    ...p, price: priceQty / p.qty, usdPrice: usdQty / p.qty,
  }));
}
