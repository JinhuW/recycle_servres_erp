// A sell order holds its inventory only once it leaves Draft. Draft orders are
// proposals — several may name the same line and only the one that ships wins,
// so the claim is staked when the order is promoted, not when it is written.
// Done is absent because it already consumed the stock (order_lines.qty is
// decremented and sold-out lines flip to 'Sold'); Closed is absent because it
// released it.
//
// Every "is this line spoken for?" query must use this list — the rule used to
// be hand-rolled at five call sites and all five had drifted apart.
export const COMMITTED_SELL_STATUSES = ['Shipped', 'Awaiting payment'] as const;

// postgres.js binds a readonly tuple as a record, not an array — the spread is
// what makes `= ANY(${committedSellStatuses()}::text[])` a text[] parameter.
export function committedSellStatuses(): string[] {
  return [...COMMITTED_SELL_STATUSES];
}
