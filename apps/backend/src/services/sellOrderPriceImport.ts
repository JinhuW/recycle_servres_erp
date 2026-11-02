// Matches a vendor-filled bid sheet's rows to a sell order's products by
// canonical part number. The sheet is read by services/priceSheet.ts, the
// reader the Market page and Review mode share; this module only decides what
// each row means for one order.

import { canonPartNumberJs } from '../lib/part-number';
import type { SheetPriceRow } from './priceSheet';

export type OrderProduct = {
  partNumber: string | null;
  label: string;
  qty: number;
  lineCount: number;
  oldPrice: number | null;
};

export type ParsedRowStatus =
  | 'matched'
  | 'not-in-order'
  | 'no-price'
  | 'invalid-price'
  | 'duplicate'
  | 'ambiguous'
  // A sheet from before v1.242.0 priced the part apart per condition.
  | 'per-condition';

export type ParsedPriceRow = {
  // Worksheet the row came from — the template ships one tab per category, so
  // (sheet, rowNumber) is a row's identity; rowNumber alone repeats per tab.
  sheet: string;
  rowNumber: number;
  rawPart: string;
  canonPart: string;
  price: number | null;
  rawPrice: string;
  status: ParsedRowStatus;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  qty?: number;
  lineCount?: number;
};

export type PriceImportPreview = {
  rows: ParsedPriceRow[];
  unmatchedProducts: OrderProduct[];
  manualProducts: OrderProduct[];
  summary: {
    matched: number;
    notInOrder: number;
    noPrice: number;
    invalid: number;
    duplicate: number;
    ambiguous: number;
  };
};

export type SellOrderLineRow = {
  label: string;
  part_number: string | null;
  qty: number;
  unit_price: number | null;
  source_unit_price: number | null;
};

// The bid sheet's product: one price covers every line of a part across
// warehouses, conditions and the labels its lines were added under, since the
// sheet prices a part once and the import applies a part's price to all of
// its lines. A line with no part number is its own product by label. oldPrice
// is native — what the vendor's new price will be compared against — and
// none when the part's lines were priced differently.
export function groupOrderProducts(rows: SellOrderLineRow[], isCny: boolean): OrderProduct[] {
  const byKey = new Map<string, OrderProduct>();
  for (const row of rows) {
    const canon = row.part_number ? canonPartNumberJs(row.part_number) : '';
    const key = canon ? `pn:${canon}` : `label:${row.label}`;
    const native = isCny ? (row.source_unit_price ?? row.unit_price) : row.unit_price;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.lineCount++;
      if (existing.oldPrice !== native) existing.oldPrice = null;
    } else {
      byKey.set(key, {
        partNumber: row.part_number,
        label: row.label,
        qty: row.qty,
        lineCount: 1,
        oldPrice: native,
      });
    }
  }
  return [...byKey.values()];
}

export function matchPriceRows(
  sheetRows: SheetPriceRow[],
  orderProducts: OrderProduct[],
): PriceImportPreview {
  const manualProducts: OrderProduct[] = [];
  const byCanon = new Map<string, { product: OrderProduct; index: number }[]>();
  orderProducts.forEach((product, index) => {
    const canon = product.partNumber ? canonPartNumberJs(product.partNumber) : '';
    if (canon === '') {
      manualProducts.push(product);
      return;
    }
    const list = byCanon.get(canon) ?? [];
    list.push({ product, index });
    byCanon.set(canon, list);
  });

  const rows: ParsedPriceRow[] = [];
  // One winner per product: a later valid price for the same product demotes
  // the earlier row to 'duplicate' (vendors often re-list corrected prices at
  // the bottom of the sheet). The map spans sheets, so re-pricing a part on
  // another tab demotes the first occurrence the same way.
  const winnerByProduct = new Map<number, ParsedPriceRow>();
  // A sheet made before v1.242.0 has a row per condition. Two of a part's
  // conditions at two prices are not a correction further down: one price
  // can't stand for both, so the part is left for the manager to price.
  const winnerCondition = new Map<number, string>();
  const perCondition = new Set<number>();
  const condKey = (c: string | null | undefined) => (c ?? '').trim().toLowerCase();

  for (const sheetRow of sheetRows) {
    const parsed: ParsedPriceRow = {
      sheet: sheetRow.sheet,
      rowNumber: sheetRow.rowNumber,
      rawPart: sheetRow.rawPart,
      canonPart: sheetRow.canonPart,
      price: sheetRow.price,
      rawPrice: sheetRow.rawPrice,
      status: 'no-price',
    };

    const candidates = byCanon.get(parsed.canonPart);
    if (!candidates) {
      parsed.status = 'not-in-order';
    } else {
      // A part under two labels (a typed line re-worded) can't be told
      // apart by part number alone.
      const target = candidates.length === 1 ? candidates[0] : null;
      if (!target) {
        parsed.status = 'ambiguous';
      } else if (sheetRow.priceKind === 'empty' || sheetRow.price === 0) {
        // A 0 on a bid is "not bidding"; as a price it would also be recorded
        // as the part's market bid and zero its max buy.
        parsed.status = 'no-price';
      } else if (sheetRow.priceKind === 'invalid') {
        parsed.status = 'invalid-price';
      } else if (perCondition.has(target.index)) {
        parsed.status = 'per-condition';
      } else {
        const prior = winnerByProduct.get(target.index);
        const cond = condKey(sheetRow.condition);
        const priorCond = winnerCondition.get(target.index) ?? '';
        if (prior && cond && priorCond && cond !== priorCond && prior.price !== sheetRow.price) {
          prior.status = 'per-condition';
          parsed.status = 'per-condition';
          perCondition.add(target.index);
          winnerByProduct.delete(target.index);
        } else {
          parsed.status = 'matched';
          parsed.partNumber = target.product.partNumber;
          parsed.label = target.product.label;
          parsed.oldPrice = target.product.oldPrice;
          parsed.qty = target.product.qty;
          parsed.lineCount = target.product.lineCount;
          if (prior) prior.status = 'duplicate';
          winnerByProduct.set(target.index, parsed);
          winnerCondition.set(target.index, cond);
        }
      }
    }
    rows.push(parsed);
  }

  const unmatchedProducts = orderProducts.filter(
    (p, i) => !winnerByProduct.has(i) && !manualProducts.includes(p),
  );

  const summary = { matched: 0, notInOrder: 0, noPrice: 0, invalid: 0, duplicate: 0, ambiguous: 0 };
  for (const row of rows) {
    if (row.status === 'matched') summary.matched++;
    else if (row.status === 'not-in-order') summary.notInOrder++;
    else if (row.status === 'no-price') summary.noPrice++;
    else if (row.status === 'invalid-price') summary.invalid++;
    else if (row.status === 'duplicate') summary.duplicate++;
    // A part this file can't price on its own, like an ambiguous one.
    else summary.ambiguous++;
  }

  return { rows, unmatchedProducts, manualProducts, summary };
}
