// A sell order holds its inventory only once it leaves Draft. Draft orders are
// proposals — several may name the same line and only the one that ships wins,
// so the claim is staked when the order is promoted, not when it is written.
// Done is absent because it already consumed the stock (order_lines.qty is
// decremented and sold-out lines flip to 'Sold'); Closed is absent because it
// released it.
//
// A commitment reserves the QUANTITY its line names, never the whole lot: 20
// units of a 100-piece line leave 80 sellable to the next order. Every "how
// much of this line is spoken for?" query must sum sol.qty over this list —
// the rule used to be hand-rolled at five call sites and all five had drifted
// apart, and an EXISTS test here silently blocks the untouched remainder.
export const COMMITTED_SELL_STATUSES = ['Shipped', 'Awaiting payment'] as const;

// postgres.js binds a readonly tuple as a record, not an array — the spread is
// what makes `= ANY(${committedSellStatuses()}::text[])` a text[] parameter.
export function committedSellStatuses(): string[] {
  return [...COMMITTED_SELL_STATUSES];
}

// Every status in which a sell order still *names* its lines — Draft included.
// A Draft reserves nothing (above), but a line it names cannot vanish either:
// the draft is re-validated on promotion and would fail then. Use this where
// the question is "is anyone still pointing at this line", the committed set
// where it is "how much of it is spoken for".
export const OPEN_SELL_STATUSES = ['Draft', ...COMMITTED_SELL_STATUSES] as const;

export function openSellStatuses(): string[] {
  return [...OPEN_SELL_STATUSES];
}

// The line statuses a sell order may hold — what validateSellLines accepts.
// Also the boundary at which a Draft stops caring about a PO stage move: a
// cascade that lands lines inside this set leaves every draft promotable, so
// only committed orders may refuse it; one that lands outside (Draft, In
// Transit) would strand a draft at promotion, so there a Draft refuses too.
export const SELLABLE_LINE_STATUSES = ['Reviewing', 'Done'] as const;

export function isSellableLineStatus(status: string): boolean {
  return (SELLABLE_LINE_STATUSES as readonly string[]).includes(status);
}
