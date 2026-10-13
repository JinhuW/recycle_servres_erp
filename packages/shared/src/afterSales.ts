// After-sales cases: the statuses and resolutions the backend route, the API
// client and the desktop page all agree on. The transition table stays with
// the route — it is the server's machine, not a vocabulary.

export const AFTER_SALES_STATUSES = ['Open', 'In progress', 'Awaiting return', 'Resolved', 'Cancelled'] as const;
export type AfterSalesStatus = typeof AFTER_SALES_STATUSES[number];

export const AFTER_SALES_RESOLUTIONS = ['return', 'discount'] as const;
export type AfterSalesResolution = typeof AFTER_SALES_RESOLUTIONS[number];

// A case is about goods the customer has: a proposal (Draft, Packing) has
// shipped nothing and a Closed order sold nothing.
export const CASEABLE_SELL_STATUSES: ReadonlySet<string> = new Set(['Shipped', 'Awaiting payment', 'Done']);
