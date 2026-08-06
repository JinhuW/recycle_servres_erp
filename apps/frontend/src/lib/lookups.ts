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

export type SellOrderStatus = 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done' | 'Closed';
export type SellOrderStatusInfo = {
  id: SellOrderStatus;
  label: string;
  short: string;
  tone: string;
  needsMeta: boolean;
  position: number;
};
export const sellOrderStatuses: SellOrderStatusInfo[] = [];

// ── Order/inventory categories (RAM/SSD/HDD/… ) ─────────────────────────────
// Backed by the `categories` table; replaces the list the UI used to hardcode
// as ['RAM','SSD','HDD','Other'] in ~7 places. Disabled categories are kept so
// settings screens can still show/toggle them; `categoryFilterOptions()` is
// the enabled-only list (plus 'all') used by list/filter chips.
export type CategoryInfo = {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
  defaultMargin: number;
  position: number;
};
export const categories: CategoryInfo[] = [];

// ── Item types (the `Other` line classifier vocabulary) ─────────────────────
// Anyone may add one from the line drawer, so this list grows during a session
// — `addItemType` folds a freshly created type into the cache rather than
// re-fetching every lookup.
export type ItemType = { id: string; name: string };
export const itemTypes: ItemType[] = [];

export function addItemType(type: ItemType): void {
  if (itemTypes.some(t => t.id === type.id)) return;
  itemTypes.push(type);
  itemTypes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// Display order for categories, matching the backend's CATEGORY_ORDER (used by
// every export) so a grouped table and a downloaded workbook list them the same
// way. Unknown ids sort after these.
export const CATEGORY_ORDER: readonly string[] = ['RAM', 'SSD', 'HDD', 'Other'];

/** Filter-chip options: 'all' followed by the enabled category ids in order. */
export function categoryFilterOptions(): string[] {
  return ['all', ...categories.filter(c => c.enabled).map(c => c.id)];
}

/**
 * Categories a new line may be filed under. Falls back to the built-in four
 * before the lookups fetch lands, so the add control is never empty on first
 * paint — the backend re-checks `enabled` on write either way.
 */
export function addableCategories(): string[] {
  const enabled = categories.filter(c => c.enabled).map(c => c.id);
  return enabled.length ? enabled : ['RAM', 'SSD', 'HDD', 'Other'];
}

type LookupsResponse = {
  catalog: Record<string, string[]>;
  priceSources: PriceSource[];
  sellOrderStatuses: SellOrderStatusInfo[];
  categories: CategoryInfo[];
  itemTypes: ItemType[];
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
      categories.splice(0, categories.length, ...data.categories);
      itemTypes.splice(0, itemTypes.length, ...(data.itemTypes ?? []));
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
  categories.length = 0;
  itemTypes.length = 0;
}
