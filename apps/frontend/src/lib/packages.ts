import { api } from './api';
import type { Carrier } from './carrierDetect';

// ── Tracked packages: standalone inbound labels, no PO yet ───────────────────
//
// Server-side since v1.77.0 (migration 0094, apps/backend/routes/packages.ts).
// Tracking is the ShipSaving poll loop's job (shipping/track.ts): it moves
// these rows through the shared status guard and the dashboard re-reads them
// on a slow tick. Statuses reuse the shipment vocabulary subset so the rail,
// chips, and filters serve both row kinds.

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

export async function listPackages(): Promise<{ items: TrackedPackage[] }> {
  return api.get<{ items: TrackedPackage[] }>('/api/packages');
}

export async function addPackage(input: {
  trackingNumber: string;
  carrier: Carrier;
  sellerName?: string;
  note?: string;
}): Promise<{ package: TrackedPackage }> {
  return api.post<{ package: TrackedPackage }>('/api/packages', input);
}

export async function removePackage(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/api/packages/${id}`);
}

/** Atomic on the server: mints the draft PO and links the package in one tx. */
export async function createPoFromPackage(pkg: TrackedPackage): Promise<{ orderId: string }> {
  return api.post<{ orderId: string }>(`/api/packages/${pkg.id}/create-po`, {});
}

/** Carrier public tracking pages — used when the provider gave us no URL. */
export function carrierTrackingUrl(carrier: Carrier, trackingNumber: string): string | null {
  switch (carrier) {
    case 'UPS': return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
    case 'FedEx': return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
    case 'USPS': return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
    // The type says this can't happen; the data (a server row) can — an <a>
    // with no href is worse than no link.
    default: return null;
  }
}
