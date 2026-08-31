// A purchase order's cost is a two-part stack: the goods (the sum of line
// costs, or a negotiated override of it) plus order-level other fees — a PayPal
// processing charge, freight, customs. Four PO surfaces render that stack and
// used to each derive it inline; this is the one definition they share.
//
// The backend keeps the same split: orders.total_cost is the goods override and
// orders.other_fees is charged on top of it, never folded into it.

import { goodsTotalIsMirror } from '@recycle-erp/shared';

export type PoCostInput = {
  /** Sum of qty * unitCost across the PO's lines. */
  lineSubtotal: number;
  /** Negotiated lot price replacing the line subtotal, or null for no override. */
  totalCostOverride?: number | null;
  otherFees?: number | null;
};

export type PoCost = {
  goods: number;
  fees: number;
  total: number;
};

export function poEffectiveCost(input: PoCostInput): PoCost {
  const goods = num(input.totalCostOverride ?? input.lineSubtotal);
  const fees = num(input.otherFees);
  return { goods, fees, total: goods + fees };
}

// Free-text money inputs are string-typed so the box can be blank, and hold
// non-numeric intermediate states while someone types ("5e", "-", ""). Those
// read as 0 rather than NaN so a half-typed fee never poisons a total.
export function parseFeeInput(raw: string): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Money columns are NUMERIC(12,2), and a fee input is seeded from `.toFixed(2)`
// while its baseline is a raw float subtraction — so `===` on the two reports a
// change that only exists in the last bits. Dirty checks compare at the
// precision the value is actually stored with.
export function feeEq(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

export type StoredGoodsTotal = {
  /**
   * What to hand `poEffectiveCost` as `totalCostOverride`. Null when the stored
   * figure is a mirror, so the live line sum wins.
   */
  override: number | null;
  /** Whether the stored figure stands apart from the lines it was loaded with. */
  negotiated: boolean;
};

/**
 * How a screen that edits lines should read `orders.total_cost`.
 *
 * `loadedLineSubtotal` is the sum as the order ARRIVED, not as the form now
 * stands — the mirror-vs-negotiated verdict is only readable before the lines
 * move, which is the same instant the backend takes it at (see `goodsTotal.ts`
 * in @recycle-erp/shared and `services/orderGoodsTotal.ts`). Take it against
 * the live sum instead and every ordinary edit reads as a negotiated price:
 * the money block freezes on the figure the page opened with, while the save
 * that follows derives and stores the new one.
 */
export function readStoredGoodsTotal(
  storedGoods: number | null | undefined,
  loadedLineSubtotal: number,
): StoredGoodsTotal {
  if (storedGoods == null || goodsTotalIsMirror(storedGoods, loadedLineSubtotal)) {
    return { override: null, negotiated: false };
  }
  return { override: storedGoods, negotiated: true };
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
