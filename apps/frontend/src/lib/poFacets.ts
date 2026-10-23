// Warehouse and payment facets for the desktop PO list. The page holds every
// PO in scope client-side, so a facet is a plain predicate over the array —
// no refetch, no skeleton — and a chip's count is what its click would show
// given every other filter on the page.

/** 'all' · a warehouse id · 'none' for POs that have no warehouse. */
export type WarehousePick = string;
/** 'all' · 'company' (the Business Account) · a payer's user id. */
export type PaymentPick = string;

export const NO_WAREHOUSE = 'none';
export const BUSINESS_ACCOUNT = 'company';

type Facetable = {
  warehouse: { id: string; short: string } | null;
  payment: 'company' | 'self';
  paidBy?: { id: string; name: string } | null;
};

export function warehouseKey(o: Facetable): string {
  return o.warehouse?.id ?? NO_WAREHOUSE;
}

/** The payer chip a PO falls under: the Business Account, or the person. A
 *  self-paid PO from a backend that predates the payer counts as nobody's —
 *  'self' — so it is still reachable from a chip of its own. */
export function paymentKey(o: Facetable): string {
  if (o.payment === 'company') return BUSINESS_ACCOUNT;
  return o.paidBy?.id ?? 'self';
}

export function matchesWarehouse(o: Facetable, pick: WarehousePick): boolean {
  return pick === 'all' || warehouseKey(o) === pick;
}

export function matchesPayment(o: Facetable, pick: PaymentPick): boolean {
  return pick === 'all' || paymentKey(o) === pick;
}

/** A persisted pick that no loaded PO answers to any more — a payer with no
 *  orders in scope, or the 'self' value an older release stored — reads as
 *  'all' rather than an empty table nobody asked for. */
export function paymentPickOrAll(pick: PaymentPick, orders: readonly Facetable[]): PaymentPick {
  if (pick === 'all' || pick === BUSINESS_ACCOUNT) return pick;
  return orders.some(o => paymentKey(o) === pick) ? pick : 'all';
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

/**
 * The payers the chip row offers, after the Business Account chip: every
 * person seen in the loaded POs, by name. Same rule as the warehouses — a
 * manager who paid nothing in scope gets no chip. `name` is null for the
 * 'self' chip an older backend's rows fall under; the row labels it.
 */
export function payerOptions(orders: readonly Facetable[]): Array<{ id: string; name: string | null }> {
  const seen = new Map<string, string | null>();
  for (const o of orders) {
    if (o.payment !== 'self') continue;
    if (o.paidBy) seen.set(o.paidBy.id, o.paidBy.name);
    else seen.set('self', null);
  }
  return [...seen].map(([id, name]) => ({ id, name }))
    .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿'));
}

/**
 * The people a Paid by select offers for one PO: the active managers by
 * name, then the PO's purchaser when they are not one, then whoever is on
 * file when no longer listed (deactivated) — the select must still show the
 * record. Members come from /api/members/names, which every role may read.
 */
export function payerChoices(
  members: readonly { id: string; name: string; role?: string }[],
  owner: { id: string; name: string } | null,
  current: { id: string; name: string } | null,
): Array<{ id: string; name: string }> {
  const out = members.filter(m => m.role === 'manager').map(m => ({ id: m.id, name: m.name }));
  if (owner && !out.some(m => m.id === owner.id)) out.push(owner);
  if (current && !out.some(m => m.id === current.id)) out.unshift(current);
  return out;
}

export type FacetCounts = {
  warehouse: Record<string, number>;
  payment: Record<string, number>;
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
  const payment: Record<string, number> = { all: 0, [BUSINESS_ACCOUNT]: 0 };
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
      const k = paymentKey(o);
      payment[k] = (payment[k] ?? 0) + 1;
      payment.all++;
    }
  }
  return { warehouse, payment };
}
