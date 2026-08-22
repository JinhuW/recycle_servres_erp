import type { TrackedPackage } from './packages';
import type { OrderSummary, Shipment, ShipmentStatus } from './types';

// Pure helpers behind the shipping dashboard: flattening the client-composed
// per-PO sections into table rows, filtering them, and exporting CSV. Kept out
// of the component so the filter/search/export logic is testable.

export type PoLabels = { order: OrderSummary; shipments: Shipment[] };
export type ShipRow = { order: OrderSummary; shipment: Shipment };

export type ShipFilter = {
  status: ShipmentStatus | 'all';
  carrier: string; // 'all' or an exact carrier name from carriersOf()
  search: string;
};

// Chip tone + label key per status — one map for the dashboard and the panel.
export const STATUS_CHIP: Record<ShipmentStatus, { cls: string; key: string }> = {
  draft: { cls: 'muted', key: 'shipStatusDraft' },
  quoted: { cls: 'muted', key: 'shipStatusQuoted' },
  purchased: { cls: 'accent', key: 'shipStatusPurchased' },
  in_transit: { cls: 'info', key: 'shipStatusInTransit' },
  delivered: { cls: 'pos', key: 'shipStatusDelivered' },
  voided: { cls: 'neg', key: 'shipStatusVoided' },
  exception: { cls: 'warn', key: 'shipStatusException' },
};

export function fmtEta(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Carrier ETAs are calendar dates, not instants: a date-only value (or its
  // UTC-midnight round trip through the DB) rendered in a western timezone
  // would show the previous day.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso) || /T00:00(:00(\.0+)?)?(Z|\+00:?00)$/.test(iso);
  return d.toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
}

/** One row per shipment, newest shipment first. */
export function flattenRows(sections: PoLabels[]): ShipRow[] {
  return sections
    .flatMap(({ order, shipments }) => shipments.map(shipment => ({ order, shipment })))
    .sort((a, b) => b.shipment.createdAt.localeCompare(a.shipment.createdAt));
}

/** Distinct carrier names across the rows, sorted. */
export function carriersOf(rows: ShipRow[]): string[] {
  return [...new Set(rows.map(r => r.shipment.carrier).filter((c): c is string => !!c))].sort();
}

export function filterRows(rows: ShipRow[], f: ShipFilter): ShipRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(({ order, shipment }) => {
    if (f.status !== 'all' && shipment.status !== f.status) return false;
    if (f.carrier !== 'all' && shipment.carrier !== f.carrier) return false;
    if (!q) return true;
    return order.id.toLowerCase().includes(q)
      || order.userName.toLowerCase().includes(q)
      || (shipment.from.name ?? '').toLowerCase().includes(q)
      || (shipment.trackingNumber ?? '').toLowerCase().includes(q);
  });
}

/** Row count per status (plus 'all') for the status-rail chips. */
export function statusCounts(rows: ShipRow[]): Record<ShipmentStatus | 'all', number> {
  const counts = { all: rows.length, draft: 0, quoted: 0, purchased: 0, in_transit: 0, delivered: 0, voided: 0, exception: 0 };
  for (const r of rows) counts[r.shipment.status]++;
  return counts;
}

// ── Inbound stream: shipments + standalone tracked packages ──────────────────
// Package statuses are a subset of ShipmentStatus, so one rail/filter serves
// both row kinds.

export type InboundRow =
  | { kind: 'shipment'; order: OrderSummary; shipment: Shipment }
  | { kind: 'package'; pkg: TrackedPackage };

function inboundCreatedAt(r: InboundRow): string {
  return r.kind === 'package' ? r.pkg.createdAt : r.shipment.createdAt;
}

/** Shipment rows and package rows in one stream, newest first. */
export function mergeInbound(rows: ShipRow[], pkgs: TrackedPackage[]): InboundRow[] {
  const all: InboundRow[] = [
    ...rows.map(r => ({ kind: 'shipment' as const, ...r })),
    ...pkgs.map(pkg => ({ kind: 'package' as const, pkg })),
  ];
  return all.sort((a, b) => inboundCreatedAt(b).localeCompare(inboundCreatedAt(a)));
}

export function filterInbound(rows: InboundRow[], f: ShipFilter): InboundRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (r.kind === 'shipment') return filterRows([r], f).length > 0;
    const p = r.pkg;
    if (f.status !== 'all' && p.status !== f.status) return false;
    if (f.carrier !== 'all' && p.carrier !== f.carrier) return false;
    if (!q) return true;
    return p.trackingNumber.toLowerCase().includes(q)
      || (p.sellerName ?? '').toLowerCase().includes(q)
      || (p.note ?? '').toLowerCase().includes(q)
      || (p.orderId ?? '').toLowerCase().includes(q);
  });
}

export function inboundCounts(rows: InboundRow[]): Record<ShipmentStatus | 'all', number> {
  const counts = { all: rows.length, draft: 0, quoted: 0, purchased: 0, in_transit: 0, delivered: 0, voided: 0, exception: 0 };
  for (const r of rows) counts[r.kind === 'package' ? r.pkg.status : r.shipment.status]++;
  return counts;
}

export function inboundCarriers(rows: InboundRow[]): string[] {
  const names = rows.map(r => (r.kind === 'package' ? r.pkg.carrier : r.shipment.carrier));
  return [...new Set(names.filter((c): c is string => !!c))].sort();
}

export type PrevSeller = {
  key: string;
  label: string;
  from: Shipment['from'];
  /** How many labels have shipped from this address. */
  count: number;
  /** Newest shipment's createdAt for this address. */
  lastUsed: string;
};

/**
 * Address book composed from past shipments: every complete seller address the
 * user can see, deduped (name + street + zip), newest first, with per-address
 * label count. Feeds the wizard's contacts rail and the seller-name typeahead
 * until a real address book exists server-side.
 */
export function previousSellers(sections: PoLabels[]): PrevSeller[] {
  const byKey = new Map<string, PrevSeller>();
  for (const { shipment: s } of flattenRows(sections)) {
    const f = s.from;
    if (!f.name || !f.street1 || !f.city || !f.state || !f.zip) continue;
    const key = [f.name, f.street1, f.zip].join('|').toLowerCase();
    const hit = byKey.get(key);
    if (hit) { hit.count++; continue; } // rows are newest-first, so the entry already holds the freshest data
    if (byKey.size >= 50) continue;
    byKey.set(key, { key, label: `${f.name} · ${f.city}, ${f.state}`, from: f, count: 1, lastUsed: s.createdAt });
  }
  return [...byKey.values()];
}

/** Name typeahead: prefix matches rank above substring matches, capped at 6. */
export function matchSellers(list: PrevSeller[], q: string): PrevSeller[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const pre: PrevSeller[] = [];
  const sub: PrevSeller[] = [];
  for (const p of list) {
    const n = (p.from.name ?? '').toLowerCase();
    if (n.startsWith(s)) pre.push(p);
    else if (n.includes(s)) sub.push(p);
  }
  return [...pre, ...sub].slice(0, 6);
}

const CSV_HEAD = ['Order', 'Created', 'Status', 'Seller', 'Seller city', 'Seller state', 'Warehouse', 'Carrier', 'Service', 'Label cost', 'Currency', 'Tracking #'];

// Excel/Sheets execute cells starting with = + - @ as formulas; seller names
// and tracking numbers are external text.
const csvEsc = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

function shipCsvCells({ order, shipment: s }: ShipRow): string[] {
  return [
    order.id,
    s.createdAt,
    s.status,
    s.from.name ?? '',
    s.from.city ?? '',
    s.from.state ?? '',
    order.warehouse?.short ?? order.warehouse?.name ?? '',
    s.carrier ?? '',
    s.service ?? '',
    s.labelCost != null ? String(s.labelCost) : '',
    s.rateCurrency,
    s.trackingNumber ?? '',
  ];
}

function pkgCsvCells(p: TrackedPackage): string[] {
  return [
    p.orderId ?? '', p.createdAt, p.status, p.sellerName ?? '', '', '', '',
    p.carrier, '', '', '', p.trackingNumber,
  ];
}

export function rowsToCsv(rows: ShipRow[]): string {
  const lines = rows.map(r => shipCsvCells(r).map(csvEsc).join(','));
  return [CSV_HEAD.map(csvEsc).join(','), ...lines].join('\r\n');
}

export function inboundToCsv(rows: InboundRow[]): string {
  const lines = rows.map(r =>
    (r.kind === 'package' ? pkgCsvCells(r.pkg) : shipCsvCells(r)).map(csvEsc).join(','));
  return [CSV_HEAD.map(csvEsc).join(','), ...lines].join('\r\n');
}
