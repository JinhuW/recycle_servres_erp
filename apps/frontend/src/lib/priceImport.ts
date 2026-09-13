// Applies confirmed vendor prices from a price-import preview onto the edit
// form's draft lines. Matching repeats the backend's rule — canonical part
// number plus an optional condition disambiguator — against the *live* draft,
// so lines the manager added or removed after the preview still resolve
// correctly.

import { canonicalPartNumber } from './format';

export type PriceApplyLine = {
  partNumber: string | null;
  condition: string | null;
  unitPrice: number;
};

export type PriceApplyRow = {
  canonPart: string;
  condition: string | null;
  price: number;
};

const normCondition = (s: string | null) =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// What the save sends the backend as a confirmed bid: the products the sheet
// priced, by (part, condition) — a null condition covers every line of the
// part. Keyed the way applyPriceRows matches, so a second import of the same
// product replaces rather than repeats it.
export type BidPart = { partNumber: string; condition: string | null };

export function mergeBidParts(current: BidPart[], rows: PriceApplyRow[]): BidPart[] {
  const byKey = new Map<string, BidPart>();
  for (const p of current) byKey.set(`${p.partNumber}|${normCondition(p.condition)}`, p);
  for (const r of rows) {
    byKey.set(`${r.canonPart}|${normCondition(r.condition)}`, { partNumber: r.canonPart, condition: r.condition });
  }
  return [...byKey.values()];
}

export function applyPriceRows<L extends PriceApplyLine>(
  lines: L[],
  rows: PriceApplyRow[],
): L[] {
  return lines.map(line => {
    const canon = canonicalPartNumber(line.partNumber);
    if (canon === '') return line;
    const row = rows.find(
      r =>
        r.canonPart === canon &&
        (r.condition === null || normCondition(r.condition) === normCondition(line.condition)),
    );
    return row ? { ...line, unitPrice: row.price } : line;
  });
}
