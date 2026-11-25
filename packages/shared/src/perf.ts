// The pages a load report may name: the frontend's DesktopViewId values, kept as
// a closed list so a report can never carry a path, an id or a query. The
// frontend's tests fail if a view is added without being listed here.
export const PERF_PAGES = [
  'home', 'analysis', 'actions', 'stock', 'submit', 'history', 'shipping', 'clients',
  'market', 'inventory', 'sellorders', 'aftersales', 'ebay', 'transfers',
  'websubmissions', 'activity', 'payments', 'internaltx', 'accounting',
  'tracker', 'wechat', 'coordinator', 'leadsReddit', 'leadsFacebook', 'settings',
] as const;

export type PerfPage = (typeof PERF_PAGES)[number];
