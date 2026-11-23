// Turns fetched eBay orders into sale candidates for the ERP's listings. Pure:
// the sync job supplies the listing lookup and decides what to write.

import type { EbayOrder } from './client';

export interface ListingLookup {
  /** ebay_listings.ebay_sku → listing id (EB-n). */
  bySku: ReadonlyMap<string, string>;
  /** ebay_listings.ebay_item_id → listing id, for listings linked by hand. */
  byItemId: ReadonlyMap<string, string>;
}

export interface SaleCandidate {
  listingId: string;
  ebayOrderId: string;
  ebayLineItemId: string;
  qty: number;
  /** USD per unit, before discounts. */
  unitPrice: number;
  /** This line's share of the order's marketplace fees, USD. */
  fees: number;
  buyer: string;
  soldAt: Date;
  cancelled: boolean;
}

const toCents = (value: string | undefined) => Math.round(Number(value ?? 0) * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Splits `totalCents` across `weights` in proportion, in whole cents, so the
 * shares add back to the total exactly (largest remainder). With no weight
 * anywhere it splits evenly.
 */
function apportion(totalCents: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const w = weights.some((x) => x > 0) ? weights.map((x) => Math.max(x, 0)) : weights.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const exact = w.map((x) => (totalCents * x) / sum);
  const shares = exact.map(Math.floor);
  let left = totalCents - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) shares[order[k].i]++;
  return shares;
}

function listingFor(line: EbayOrder['lineItems'][number], lookup: ListingLookup): string | null {
  if (line.sku) {
    const bySku = lookup.bySku.get(line.sku);
    if (bySku !== undefined) return bySku;
  }
  return lookup.byItemId.get(line.legacyItemId) ?? null;
}

/**
 * One candidate per line item that belongs to a known listing, matched by SKU
 * first and then by eBay item number. The order's marketplace fee is split
 * over all its lines by line total, so a line for an unknown listing still
 * takes its share rather than loading it onto ours.
 */
export function matchOrders(orders: Iterable<EbayOrder>, lookup: ListingLookup): SaleCandidate[] {
  const out: SaleCandidate[] = [];
  for (const order of orders) {
    const lines = order.lineItems ?? [];
    const fees = apportion(
      toCents(order.totalMarketplaceFee?.value),
      lines.map((l) => toCents(l.total?.value)),
    );
    const cancelled = order.cancelStatus?.cancelState === 'CANCELED';
    lines.forEach((line, i) => {
      const listingId = listingFor(line, lookup);
      if (listingId === null) return;
      const qty = line.quantity;
      out.push({
        listingId,
        ebayOrderId: order.orderId,
        ebayLineItemId: line.lineItemId,
        qty,
        unitPrice: round2(toCents(line.lineItemCost?.value) / 100 / Math.max(qty, 1)),
        fees: fees[i] / 100,
        buyer: order.buyer?.username ?? '',
        soldAt: new Date(order.creationDate),
        cancelled,
      });
    });
  }
  return out;
}
