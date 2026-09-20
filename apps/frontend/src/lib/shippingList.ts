import type { PackageStatus, TrackedPackage } from './packages';

// Pure helpers behind the shipping dashboard: filtering the package rows and
// exporting CSV. Kept out of the component so the filter/search/export logic
// is testable.

export type ShipFilter = {
  status: PackageStatus | 'all';
  carrier: string; // 'all' or an exact carrier name from inboundCarriers()
  search: string;
};

// Chip tone + label key per status — one map for the dashboard and the PO
// journey.
export const STATUS_CHIP: Record<PackageStatus, { cls: string; key: string }> = {
  purchased: { cls: 'accent', key: 'shipStatusPurchased' },
  in_transit: { cls: 'info', key: 'shipStatusInTransit' },
  delivered: { cls: 'pos', key: 'shipStatusDelivered' },
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

// ── Inbound stream: tracked packages ─────────────────────────────────────────
// Kept as a tagged row so the dashboard and the phone list address a package
// the same way they always did.

export type InboundRow = { kind: 'package'; pkg: TrackedPackage };

/** Package rows as the inbound stream, newest first. */
export function mergeInbound(pkgs: TrackedPackage[]): InboundRow[] {
  return pkgs
    .map(pkg => ({ kind: 'package' as const, pkg }))
    .sort((a, b) => b.pkg.createdAt.localeCompare(a.pkg.createdAt));
}

export function filterInbound(rows: InboundRow[], f: ShipFilter): InboundRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(({ pkg: p }) => {
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

export function inboundCounts(rows: InboundRow[]): Record<PackageStatus | 'all', number> {
  const counts = { all: rows.length, purchased: 0, in_transit: 0, delivered: 0, exception: 0 };
  for (const r of rows) counts[r.pkg.status]++;
  return counts;
}

export function inboundCarriers(rows: InboundRow[]): string[] {
  return [...new Set(rows.map(r => r.pkg.carrier))].sort();
}

const CSV_HEAD = ['Order', 'Created', 'Tracked by', 'Status', 'Seller', 'Carrier', 'Tracking #', 'PayPal txn', 'Source'];

// Excel/Sheets execute cells starting with = + - @ as formulas; seller names
// and tracking numbers are external text.
const csvEsc = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

function pkgCsvCells(p: TrackedPackage): string[] {
  return [
    p.orderId ?? '', p.createdAt, p.creatorName ?? '', p.status, p.sellerName ?? '',
    p.carrier, p.trackingNumber, p.paypalTxnId ?? '', p.source ?? '',
  ];
}

export function inboundToCsv(rows: InboundRow[]): string {
  const lines = rows.map(r => pkgCsvCells(r.pkg).map(csvEsc).join(','));
  return [CSV_HEAD.map(csvEsc).join(','), ...lines].join('\r\n');
}
