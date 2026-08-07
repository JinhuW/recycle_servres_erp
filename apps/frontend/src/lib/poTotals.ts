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

/** A cent. Below this, a stored goods total IS the line sum. */
export const GOODS_EPSILON = 0.01;

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
