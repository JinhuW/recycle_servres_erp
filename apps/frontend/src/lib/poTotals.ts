// A purchase order's cost is a two-part stack: the goods (the sum of line
// costs, or a negotiated override of it) plus order-level other fees — a PayPal
// processing charge, freight, customs. Four PO surfaces render that stack and
// used to each derive it inline; this is the one definition they share.
//
// The backend keeps the same split: orders.total_cost is the goods override and
// orders.other_fees is charged on top of it, never folded into it.

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

/** A cent. Below this, a typed goods total IS the line sum. */
export const GOODS_EPSILON = 0.01;

export type GoodsSplit = {
  /** What the goods total should become. */
  goods: number;
  /** Amount to ADD to other fees. 0 when nothing moves. */
  overflow: number;
};

// A purchaser reads one number off the supplier's invoice; they don't think in
// goods-vs-fees. So when the goods total they type is above the line sum, the
// excess is the fee, and this splits it out.
//
// Only upward. A total BELOW the line sum is a negotiated lot discount, and it
// has to stay in the goods figure — other_fees carries CHECK (>= 0) in the DB,
// so a negative can't live there anyway.
//
// The caller ADDS `overflow` to whatever fee is already recorded rather than
// replacing it, which is what keeps the all-in total unchanged across the move.
export function splitGoodsOverflow(typedGoods: number, lineSubtotal: number): GoodsSplit {
  if (!Number.isFinite(typedGoods) || !Number.isFinite(lineSubtotal)) {
    return { goods: typedGoods, overflow: 0 };
  }
  if (typedGoods <= lineSubtotal + GOODS_EPSILON) {
    return { goods: typedGoods, overflow: 0 };
  }
  // 11610.30 - 11530.50 is 79.80000000000018 in float. Unrounded that reads as
  // dust in the input and travels to a NUMERIC(12,2) column.
  return { goods: lineSubtotal, overflow: round2(typedGoods - lineSubtotal) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
