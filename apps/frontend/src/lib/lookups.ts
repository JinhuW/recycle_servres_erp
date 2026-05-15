// Runtime cache for DB-backed lookup data (dropdown options, price sources,
// sell-order + order statuses). main.tsx awaits `loadLookups()`
// before rendering the app, so every consumer can read these as plain values.
//
// Types stay as string-literal unions because the DB CHECK constraints in
// sell_orders.status (and the order_lines.status convention) make the set of
// valid values part of the schema. Adding a new value is a migration.

import { api } from './api';

// ── Catalog option groups (RAM/SSD spec dropdowns, conditions) ──────────────
// Each array is mutated in place by `loadLookups()`. Consumers re-export from
// catalog.ts and read these references directly.
export const catalog = {
  RAM_BRAND:     [] as string[],
  RAM_TYPE:      [] as string[],
  RAM_CLASS:     [] as string[],
  RAM_RANK:      [] as string[],
  RAM_CAP:       [] as string[],
  RAM_SPEED:     [] as string[],
  SSD_BRAND:     [] as string[],
  SSD_INTERFACE: [] as string[],
  SSD_FORM:      [] as string[],
  SSD_CAP:       [] as string[],
  HDD_BRAND:     [] as string[],
  HDD_INTERFACE: [] as string[],
  HDD_FORM:      [] as string[],
  HDD_CAP:       [] as string[],
  HDD_RPM:       [] as string[],
  CONDITION:     [] as string[],
};

export type PriceSource = { id: string; label: string };
export const priceSources: PriceSource[] = [];

export type SellOrderStatus = 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done';
export type SellOrderStatusInfo = {
  id: SellOrderStatus;
  label: string;
  short: string;
  tone: string;
  needsMeta: boolean;
  position: number;
};
export const sellOrderStatuses: SellOrderStatusInfo[] = [];

type LookupsResponse = {
  catalog: Record<string, string[]>;
  priceSources: PriceSource[];
  sellOrderStatuses: SellOrderStatusInfo[];
};

let loaded = false;
let inflight: Promise<void> | null = null;

export function loadLookups(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await api.get<LookupsResponse>('/api/lookups');
      // Mutate in place so any module that holds a reference sees the values.
      for (const [group, values] of Object.entries(data.catalog)) {
        const target = (catalog as Record<string, string[]>)[group];
        if (target) target.splice(0, target.length, ...values);
      }
      priceSources.splice(0, priceSources.length, ...data.priceSources);
      sellOrderStatuses.splice(0, sellOrderStatuses.length, ...data.sellOrderStatuses);
      loaded = true;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Drop all cached lookups so the next `loadLookups()` re-fetches. Called on
// logout so a subsequent login (potentially as a different user) doesn't read
// the previous session's catalog.
export function resetLookups(): void {
  loaded = false;
  inflight = null;
  for (const arr of Object.values(catalog)) arr.length = 0;
  priceSources.length = 0;
  sellOrderStatuses.length = 0;
}
