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
  // Server-built carrier deep link, same as shipments.trackingUrl — the
  // carrier→URL table lives once, in the backend.
  trackingUrl: string | null;
  createdAt: string;
};

/** `mine` pins a manager to their own rows, mirroring GET /api/shipments. */
export async function listPackages(opts?: { mine?: boolean }): Promise<{ items: TrackedPackage[] }> {
  return api.get<{ items: TrackedPackage[] }>(`/api/packages${opts?.mine ? '?mine=true' : ''}`);
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
