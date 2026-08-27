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
  paypalTxnId: string | null;
  paymentScreenshotUrl: string | null;
  orderId: string | null;
  // Server-built carrier deep link, same as shipments.trackingUrl — the
  // carrier→URL table lives once, in the backend.
  trackingUrl: string | null;
  /** Who tracked the box — null only for rows whose user has been removed. */
  creatorName: string | null;
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
  paypalTxnId?: string;
  paymentScreenshotKey?: string;
  paymentScreenshotUrl?: string;
}): Promise<{ package: TrackedPackage }> {
  return api.post<{ package: TrackedPackage }>('/api/packages', input);
}

// ── PayPal payment screenshot scan ───────────────────────────────────────────
// Scan-first, like /api/scan/label: the screenshot lands in R2 and the AI
// reads the transaction id in one round trip; nothing persists until the
// add-package submit carries the reference.

export type PaymentScanResponse = {
  storageKey: string;
  deliveryUrl: string;
  txnId: string | null;
  confidence: number;
  provider: 'stub' | 'openrouter';
};

export async function scanPaymentScreenshot(file: File | Blob, filename = 'paypal.jpg'): Promise<PaymentScanResponse> {
  const form = new FormData();
  form.append('file', file, filename);
  return api.upload<PaymentScanResponse>('/api/scan/payment', form);
}

export type LookedUpPackage = TrackedPackage;

/**
 * Resolves a scanned label barcode to a tracked package. The server matches
 * tolerantly (carrier barcodes wrap the tracking number in routing digits)
 * and answers null both for "nobody tracked this box" and for rows outside
 * the caller's scope.
 */
export async function lookupPackage(code: string): Promise<{ package: LookedUpPackage | null }> {
  return api.get<{ package: LookedUpPackage | null }>(
    `/api/packages/lookup?code=${encodeURIComponent(code)}`,
  );
}

export async function removePackage(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/api/packages/${id}`);
}

/** Atomic on the server: mints the draft PO and links the package in one tx. */
export async function createPoFromPackage(pkg: TrackedPackage): Promise<{ orderId: string }> {
  return api.post<{ orderId: string }>(`/api/packages/${pkg.id}/create-po`, {});
}
