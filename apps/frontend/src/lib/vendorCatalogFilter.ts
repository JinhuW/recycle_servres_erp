import type { CatalogItem } from './vendor';
import { itemLabel } from './vendor';

// Mirrors the desktop inventory attribute facets (see DesktopInventory.tsx
// ATTR_SCHEMA).  Labels stay English to match that page verbatim; the catalog
// is browsed client-side so filtering/faceting runs in the browser rather than
// via backend query params.
export type AttrSpec = { key: string; label: string; format?: (v: string) => string };

export const VENDOR_ATTR_SCHEMA: Record<string, AttrSpec[]> = {
  RAM: [
    { key: 'generation',     label: 'Generation' },
    { key: 'speed',          label: 'Speed', format: v => `${v} MHz` },
    { key: 'brand',          label: 'Brand' },
    { key: 'capacity',       label: 'Capacity' },
    { key: 'type',           label: 'Device' },
    { key: 'classification', label: 'Form' },
    { key: 'rank',           label: 'Rank' },
  ],
  SSD: [
    { key: 'brand',       label: 'Brand' },
    { key: 'capacity',    label: 'Capacity' },
    { key: 'interface',   label: 'Interface' },
    { key: 'form_factor', label: 'Form factor' },
  ],
  HDD: [
    { key: 'brand',       label: 'Brand' },
    { key: 'capacity',    label: 'Capacity' },
    { key: 'interface',   label: 'Interface' },
    { key: 'form_factor', label: 'Form factor' },
    { key: 'rpm',         label: 'RPM', format: v => `${v} RPM` },
  ],
};

export function attrSpecsFor(category: string): AttrSpec[] {
  return VENDOR_ATTR_SCHEMA[category] ?? [];
}

// `speed`/`rpm` are stored as plain numeric strings; sort them as numbers so
// e.g. 4GB/8GB/16GB don't fall into lexical order on the chips.
const NUMERIC_ATTRS = new Set(['speed', 'rpm']);
export function sortAttrValues(key: string, values: string[]): string[] {
  if (NUMERIC_ATTRS.has(key)) {
    return [...values].sort((a, b) => Number(a) - Number(b));
  }
  return [...values].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export type AttrFilters = Record<string, string[]>;

function attrVal(it: CatalogItem, key: string): string | null {
  const v = (it as Record<string, unknown>)[key];
  return v == null || v === '' ? null : String(v);
}

export function matchesSearch(it: CatalogItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    itemLabel(it), it.part_number, it.brand, it.capacity, it.generation,
    it.type, it.classification, it.rank, it.speed, it.interface,
    it.form_factor, it.description, it.condition, it.category,
  ].filter(Boolean).join(' ').toLowerCase();
  return needle.split(/\s+/).every(tok => hay.includes(tok));
}

function matchesAttrs(it: CatalogItem, filters: AttrFilters): boolean {
  for (const [key, vals] of Object.entries(filters)) {
    if (!vals.length) continue;
    const v = attrVal(it, key);
    if (v == null || !vals.includes(v)) return false;
  }
  return true;
}

export function filterCatalogItems(
  items: CatalogItem[], q: string, filters: AttrFilters,
): CatalogItem[] {
  return items.filter(it => matchesSearch(it, q) && matchesAttrs(it, filters));
}

// Faceted counts: each key is counted over items passing the search and every
// OTHER active attribute filter (but not its own), so counts show what picking
// a value would yield and the current selection stays changeable.
export function computeFacets(
  items: CatalogItem[], specs: AttrSpec[], q: string, filters: AttrFilters,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const spec of specs) {
    const others: AttrFilters = {};
    for (const [k, v] of Object.entries(filters)) if (k !== spec.key) others[k] = v;
    const counts: Record<string, number> = {};
    for (const it of items) {
      if (!matchesSearch(it, q)) continue;
      if (!matchesAttrs(it, others)) continue;
      const v = attrVal(it, spec.key);
      if (v == null) continue;
      counts[v] = (counts[v] ?? 0) + 1;
    }
    out[spec.key] = counts;
  }
  return out;
}
