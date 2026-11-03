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

// The parts the sheet priced, at the price it gave. Keyed the way
// applyPriceRows matches, so a second import of the same part replaces rather
// than repeats it.
export type ImportedBid = { partNumber: string; price: number };
// What the save sends the backend as a confirmed bid.
export type BidPart = { partNumber: string };

export function mergeBidParts(current: ImportedBid[], rows: PriceApplyRow[]): ImportedBid[] {
  const byPart = new Map<string, ImportedBid>();
  for (const p of current) byPart.set(p.partNumber, p);
  for (const r of rows) byPart.set(r.canonPart, { partNumber: r.canonPart, price: r.price });
  return [...byPart.values()];
}

// The imported parts still at the sheet's price on every line. A price typed
// over the import afterwards is the manager's, not the customer's bid.
export function confirmedBidParts(lines: PriceApplyLine[], bids: ImportedBid[]): BidPart[] {
  return bids
    .filter(b => {
      const own = lines.filter(l => canonicalPartNumber(l.partNumber) === b.partNumber);
      return own.length > 0 && own.every(l => l.unitPrice === b.price);
    })
    .map(b => ({ partNumber: b.partNumber }));
}

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
