import { api } from './api';
import type { Carrier } from './carrierDetect';

// ── Tracked packages: standalone inbound labels, no PO yet ───────────────────
//
// AGREED API CONTRACT (backend pending — Jinhu implements):
//   GET    /api/packages                 → { items: TrackedPackage[] }
//   POST   /api/packages                 { trackingNumber, carrier, sellerName?, note? }
//                                        → { package: TrackedPackage }  (status starts 'purchased')
//   POST   /api/packages/:id/create-po   → { orderId }
//          Creates a draft PO (as /api/orders/draft does, notes carrying the
//          seller + tracking number) and links the package to it, atomically.
//   DELETE /api/packages/:id             → { ok: true }  (only while orderId is null)
//
// Tracking is server-side: the ShipSaving poll loop (shipping/track.ts) also
// asks about these numbers and applies moves through the shared status guard.
// Statuses reuse the shipment vocabulary subset so the dashboard rail, chips,
// and filters work unchanged.
//
// Until those endpoints exist this module persists to localStorage and
// simulates carrier movement so the flow can be exercised end-to-end. The
// exported call shapes match the contract 1:1 — when the backend lands, each
// body below collapses to one api.* call.

export type PackageStatus = 'purchased' | 'in_transit' | 'delivered' | 'exception';

export type TrackedPackage = {
  id: string;
  trackingNumber: string;
  carrier: Carrier;
  status: PackageStatus;
  trackingEta: string | null;
  lastTrackedAt: string | null;
  sellerName: string | null;
  note: string | null;
  orderId: string | null;
  createdAt: string;
};

// Demo progression while the backend is pending: a freshly added label sits at
// 'purchased', starts moving at 2 min, and lands at 5 min.
const IN_TRANSIT_AFTER_MS = 2 * 60_000;
const DELIVERED_AFTER_MS = 5 * 60_000;

export function progressedStatus(createdAtIso: string, nowMs: number): PackageStatus {
  const age = nowMs - Date.parse(createdAtIso);
  if (age >= DELIVERED_AFTER_MS) return 'delivered';
  if (age >= IN_TRANSIT_AFTER_MS) return 'in_transit';
  return 'purchased';
}

const STORE_KEY = 'recycle-erp.mock-packages';

function readStore(): TrackedPackage[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as TrackedPackage[]) : [];
  } catch {
    return [];
  }
}

function writeStore(items: TrackedPackage[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items));
  } catch { /* storage full/blocked — the list just won't survive a reload */ }
}

function withProgress(p: TrackedPackage, nowMs: number): TrackedPackage {
  const status = progressedStatus(p.createdAt, nowMs);
  return {
    ...p,
    status,
    trackingEta: status === 'delivered' ? null : new Date(Date.parse(p.createdAt) + DELIVERED_AFTER_MS).toISOString(),
    lastTrackedAt: new Date(nowMs).toISOString(),
  };
}

export async function listPackages(): Promise<{ items: TrackedPackage[] }> {
  // Contract: api.get<{ items: TrackedPackage[] }>('/api/packages')
  const now = Date.now();
  return { items: readStore().map(p => withProgress(p, now)) };
}

export async function addPackage(input: {
  trackingNumber: string;
  carrier: Carrier;
  sellerName?: string;
  note?: string;
}): Promise<{ package: TrackedPackage }> {
  // Contract: api.post<{ package: TrackedPackage }>('/api/packages', input)
  const now = new Date().toISOString();
  const pkg: TrackedPackage = {
    id: `pkg-${crypto.randomUUID()}`,
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    status: 'purchased',
    trackingEta: null,
    lastTrackedAt: null,
    sellerName: input.sellerName?.trim() || null,
    note: input.note?.trim() || null,
    orderId: null,
    createdAt: now,
  };
  writeStore([pkg, ...readStore()]);
  return { package: pkg };
}

export async function removePackage(id: string): Promise<{ ok: true }> {
  // Contract: api.delete<{ ok: true }>(`/api/packages/${id}`)
  writeStore(readStore().filter(p => p.id !== id));
  return { ok: true };
}

export async function createPoFromPackage(pkg: TrackedPackage): Promise<{ orderId: string }> {
  // Contract: api.post<{ orderId }>(`/api/packages/${pkg.id}/create-po`, {})
  // The draft-PO half is real already; only the package→order link is mocked.
  const notes = ['Created from delivered package', pkg.carrier, pkg.trackingNumber, pkg.sellerName]
    .filter(Boolean).join(' · ');
  const r = await api.post<{ id: string }>('/api/orders/draft', { notes });
  writeStore(readStore().map(p => (p.id === pkg.id ? { ...p, orderId: r.id } : p)));
  return { orderId: r.id };
}

/** Carrier public tracking pages — used when the provider gave us no URL. */
export function carrierTrackingUrl(carrier: Carrier, trackingNumber: string): string | null {
  switch (carrier) {
    case 'UPS': return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
    case 'FedEx': return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
    case 'USPS': return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
    // The type says this can't happen; the data (a server row, a stale mock)
    // can — an <a> with no href is worse than no link.
    default: return null;
  }
}
