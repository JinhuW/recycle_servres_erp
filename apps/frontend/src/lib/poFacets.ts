// Warehouse and payment facets for the desktop PO list. The page holds every
// PO in scope client-side, so a facet is a plain predicate over the array —
// no refetch, no skeleton — and a chip's count is what its click would show
// given every other filter on the page.

/** 'all' · a warehouse id · 'none' for POs that have no warehouse. */
export type WarehousePick = string;
export type PaymentPick = 'all' | 'company' | 'self';

export const NO_WAREHOUSE = 'none';

type Facetable = {
  warehouse: { id: string; short: string } | null;
  payment: 'company' | 'self';
};

export function warehouseKey(o: Facetable): string {
  return o.warehouse?.id ?? NO_WAREHOUSE;
}

export function matchesWarehouse(o: Facetable, pick: WarehousePick): boolean {
  return pick === 'all' || warehouseKey(o) === pick;
}

export function matchesPayment(o: Facetable, pick: PaymentPick): boolean {
  return pick === 'all' || o.payment === pick;
}

/**
 * The warehouses the chip row offers: every one seen in the loaded POs, by
 * short code, with a trailing No-warehouse entry only when some PO has none.
 * Listed from the POs rather than the warehouse table so the row never offers
 * a pick that would empty the table.
 */
export function warehouseOptions(orders: readonly Facetable[]): Array<{ id: string; short: string }> {
  const seen = new Map<string, string>();
  let none = false;
  for (const o of orders) {
    if (o.warehouse) seen.set(o.warehouse.id, o.warehouse.short);
    else none = true;
  }
  const out = [...seen].map(([id, short]) => ({ id, short }))
    .sort((a, b) => a.short.localeCompare(b.short));
  if (none) out.push({ id: NO_WAREHOUSE, short: '' });
  return out;
}

export type FacetCounts = {
  warehouse: Record<string, number>;
  payment: Record<PaymentPick, number>;
};

/**
 * Per-chip counts. `narrow` is every filter the page applies *after* the
 * facets (Done prune, stage, Sold); each group is counted with the other
 * group's pick applied but not its own, so a chip says what clicking it shows.
 */
export function facetCounts<T extends Facetable>(
  orders: readonly T[],
  picks: { warehouse: WarehousePick; payment: PaymentPick },
  narrow: (o: T) => boolean,
): FacetCounts {
  const warehouse: Record<string, number> = {};
  const payment: Record<PaymentPick, number> = { all: 0, company: 0, self: 0 };
  for (const o of orders) {
    if (!narrow(o)) continue;
    const wh = matchesWarehouse(o, picks.warehouse);
    const pay = matchesPayment(o, picks.payment);
    if (pay) {
      const k = warehouseKey(o);
      warehouse[k] = (warehouse[k] ?? 0) + 1;
      warehouse.all = (warehouse.all ?? 0) + 1;
    }
    if (wh) {
      payment[o.payment]++;
      payment.all++;
    }
  }
  return { warehouse, payment };
}
