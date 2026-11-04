// The pages a load report may name: the frontend's DesktopViewId values, kept as
// a closed list so a report can never carry a path, an id or a query. The
// frontend's tests fail if a view is added without being listed here.
export const PERF_PAGES = [
  'home', 'analysis', 'stock', 'submit', 'history', 'shipping', 'clients',
  'market', 'inventory', 'sellorders', 'aftersales', 'transfers',
  'websubmissions', 'activity', 'payments', 'internaltx', 'accounting',
  'tracker', 'wechat', 'coordinator', 'leadsReddit', 'settings',
] as const;

export type PerfPage = (typeof PERF_PAGES)[number];

export const PERF_WINDOWS = ['24h', '7d', '30d'] as const;
export type PerfWindow = (typeof PERF_WINDOWS)[number];

// Below this many requests a percentile is one slow call away from a different
// answer, so a release compare marks the row instead of ranking on it.
export const PERF_LOW_SAMPLE = 30;

export interface PerfRouteRow {
  route: string;
  count: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  totalMs: number;
  // Polled by fleet hosts and workers rather than waited on by a person.
  machine: boolean;
}

export interface PerfLoadRow {
  shell: string;
  page: string;
  count: number;
  lcpP50: number | null;
  lcpP75: number | null;
  lcpP95: number | null;
  loadP75: number | null;
  ttfbP75: number | null;
}

export interface PerfVersionRow {
  version: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export interface PerfCompareSide {
  count: number;
  p50: number;
  p95: number;
}

export interface PerfCompareRow {
  route: string;
  from: PerfCompareSide | null;
  to: PerfCompareSide | null;
  lowSample: boolean;
  machine: boolean;
}
