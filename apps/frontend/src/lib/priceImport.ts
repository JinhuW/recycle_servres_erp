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

// What the save sends the backend as a confirmed bid: the parts the sheet
// priced. Keyed the way applyPriceRows matches, so a second import of the
// same part replaces rather than repeats it.
export type BidPart = { partNumber: string };

export function mergeBidParts(current: BidPart[], rows: PriceApplyRow[]): BidPart[] {
  const byPart = new Map<string, BidPart>();
  for (const p of current) byPart.set(p.partNumber, p);
  for (const r of rows) byPart.set(r.canonPart, { partNumber: r.canonPart });
  return [...byPart.values()];
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
