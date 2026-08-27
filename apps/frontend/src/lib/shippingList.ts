import type { TrackedPackage } from './packages';
import type { Shipment, ShipmentStatus } from './types';

// Pure helpers behind the shipping dashboard: filtering the shipment/package
// rows and exporting CSV. Kept out of the component so the filter/search/
// export logic is testable.

/** The slice of the order the shipping table renders and searches — what
 *  GET /api/shipments joins in (a full OrderSummary also satisfies it). */
export type ShipOrder = {
  id: string;
  userName: string;
  lifecycle: string;
  paypalTxnId: string | null;
  warehouse: { id?: string; name?: string | null; short: string; region: string } | null;
};

export type ShipRow = { order: ShipOrder; shipment: Shipment };

export type ShipFilter = {
  status: ShipmentStatus | 'all';
  carrier: string; // 'all' or an exact carrier name from inboundCarriers()
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

export function filterRows(rows: ShipRow[], f: ShipFilter): ShipRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(({ order, shipment }) => {
    if (f.status !== 'all' && shipment.status !== f.status) return false;
    if (f.carrier !== 'all' && shipment.carrier !== f.carrier) return false;
    if (!q) return true;
    return order.id.toLowerCase().includes(q)
      || order.userName.toLowerCase().includes(q)
      || (order.paypalTxnId ?? '').toLowerCase().includes(q)
      || (shipment.from.name ?? '').toLowerCase().includes(q)
      || (shipment.trackingNumber ?? '').toLowerCase().includes(q);
  });
}

// ── Inbound stream: shipments + standalone tracked packages ──────────────────
// Package statuses are a subset of ShipmentStatus, so one rail/filter serves
// both row kinds.

export type InboundRow =
  | { kind: 'shipment'; order: ShipOrder; shipment: Shipment }
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
      || (p.creatorName ?? '').toLowerCase().includes(q)
      || (p.sellerName ?? '').toLowerCase().includes(q)
      || (p.note ?? '').toLowerCase().includes(q)
      || (p.paypalTxnId ?? '').toLowerCase().includes(q)
      || (p.source ?? '').includes(q)
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

/** Name typeahead over GET /api/shipping/contacts entries:
 *  prefix matches rank above substring matches, capped at 6. */
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

const CSV_HEAD = ['Order', 'Created', 'Submitted by', 'Status', 'Seller', 'Seller city', 'Seller state', 'Warehouse', 'Carrier', 'Service', 'Label cost', 'Currency', 'Tracking #', 'PayPal txn', 'Source'];

// Excel/Sheets execute cells starting with = + - @ as formulas; seller names
// and tracking numbers are external text.
const csvEsc = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

function shipCsvCells({ order, shipment: s }: ShipRow): string[] {
  return [
    order.id,
    s.createdAt,
    order.userName,
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
    order.paypalTxnId ?? '',
    '',
  ];
}

function pkgCsvCells(p: TrackedPackage): string[] {
  return [
    p.orderId ?? '', p.createdAt, p.creatorName ?? '', p.status, p.sellerName ?? '', '', '', '',
    p.carrier, '', '', '', p.trackingNumber, p.paypalTxnId ?? '', p.source ?? '',
  ];
}

export function inboundToCsv(rows: InboundRow[]): string {
  const lines = rows.map(r =>
    (r.kind === 'package' ? pkgCsvCells(r.pkg) : shipCsvCells(r)).map(csvEsc).join(','));
  return [CSV_HEAD.map(csvEsc).join(','), ...lines].join('\r\n');
}
