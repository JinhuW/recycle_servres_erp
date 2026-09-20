// Package-tracking contract. One tracking source behind one interface:
//
//   shippo:  Shippo's tracking API (any carrier's number, webhook + poll)
//   stub:    an always-in-transit canned answer (offline dev / tests)
//
// Provider is picked by credential presence — see pickTrackingClient.

export type PackageStatus = 'purchased' | 'in_transit' | 'delivered' | 'exception';

export interface TrackingInfo {
  // Provider status string, stored verbatim for display. '' means the payload
  // carried no status at all — the apply* writers keep the stored value rather
  // than overwriting a real carrier string with a placeholder.
  raw: string;
  normalized: PackageStatus;
  eta: Date | null;
}

// Nobody here bought the label, so a source has to track a stranger's number
// by (number, carrier) alone.
export interface TrackingSource {
  getShipment(trackingNumber: string, carrier: string | null): Promise<TrackingInfo>;
}

// Carrier ETAs arrive in two genuinely different shapes and each needs its own
// reading:
//
//   no offset  ("2025-08-26 22:37:27", "2025-08-26")  — a calendar date in the
//              destination's timezone. Parsing it as a server-local instant
//              would shift the day for most viewers (the server runs UTC), so
//              keep only the date part as UTC midnight: the exact shape the
//              frontend's fmtEta renders as a timezone-free calendar date.
//   an offset  ("2026-08-28T03:00:00.000Z", Shippo)   — a real instant. An
//              end-of-day ETA of Thu 21:00 MT is wired as Fri 03:00 UTC, so
//              truncating it would name the wrong day for every ETA past
//              ~18:00 MT. Keep the instant and let fmtEta render it in the
//              reader's own timezone.
export function parseEta(s: string | null | undefined): Date | null {
  if (!s) return null;
  const raw = s.trim();
  if (!raw) return null;
  const hasOffset = /\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const m = hasOffset ? null : /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  const d = m ? new Date(`${m[1]}T00:00:00Z`) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Backstop deep link rendered in the UI regardless of provider health, so a
// tracking number is always one click from the carrier's own page.
export function carrierTrackingUrl(carrier: string, trackingNumber: string): string | null {
  const n = encodeURIComponent(trackingNumber.replace(/\s+/g, ''));
  switch (carrier.trim().toLowerCase()) {
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case 'ups':
      return `https://www.ups.com/track?tracknum=${n}`;
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case 'dhl':
    case 'dhl express':
      return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
    default:
      return null;
  }
}
