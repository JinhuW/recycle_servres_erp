// Whether the bank paid what a PO says it cost. The paid side is the net of
// the bank payments linked to it (`linkedPaid`, the list chip's figure); the
// cost side is goods + other fees, the PO page's Total cost — every prod PO
// with fees and a linked payment was paid goods + fees, never goods alone.

import { poEffectiveCost } from './poTotals';
import type { Order, OrderLine } from './types';

export type PaymentGap = {
  paid: number;
  total: number;
  /** paid − total: positive when the bank paid more than the PO costs. */
  diff: number;
};

/**
 * Null when there is nothing to warn about: the figures agree to the cent,
 * nothing is linked (or the reader isn't a manager, so `paid` never arrived),
 * or the PO is self-paid — bank money on one of those is the purchaser's
 * reimbursement plus commission, so it never matches by design. Exact to the
 * cent because staff already enter cents-sized "rounding adjustment" fees to
 * make the two agree.
 */
export function paymentGap(
  paid: number | null | undefined,
  total: number,
  payment: 'company' | 'self',
): PaymentGap | null {
  if (payment !== 'company' || typeof paid !== 'number') return null;
  const diffCents = Math.round(paid * 100) - Math.round(total * 100);
  if (diffCents === 0) return null;
  return { paid, total, diff: diffCents / 100 };
}

/**
 * The total cost the PO will have once Review mode's Approve has set the lines
 * counted 0 to qty 0. A goods total that follows the lines drops by their
 * value — exactly, since a qty edit moves `qty_purchased` with it; a
 * negotiated lot price stays where it is.
 */
export function reviewApproveTotal(
  order: Pick<Order, 'lines' | 'totalCost' | 'otherFees' | 'goodsFollowsLines'>,
  toZero: Pick<OrderLine, 'qty' | 'unitCost'>[],
): number {
  const lineSubtotal = order.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  const saved = poEffectiveCost({
    lineSubtotal,
    totalCostOverride: order.totalCost,
    otherFees: order.otherFees,
  }).total;
  if (order.goodsFollowsLines === false) return saved;
  return saved - toZero.reduce((s, l) => s + l.qty * l.unitCost, 0);
}
