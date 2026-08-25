// Shipping-provider contract. Two implementations behind one interface:
//
//   shipsaving:  ShipSaving Legacy API v1 (real labels, real money)
//   stub:        deterministic canned rates/labels (offline dev / tests / demo)
//
// Provider is picked by credential presence — see pickShippingClient.

export type ShippingProvider = 'shipsaving' | 'stub';

export type ShipmentStatus =
  | 'draft'
  | 'quoted'
  | 'purchased'
  | 'in_transit'
  | 'delivered'
  | 'voided'
  | 'exception';

export interface ShipAddress {
  name: string;
  phone: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO-2
}

export interface ShipPackage {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export interface RateQuote {
  rateId: string;
  carrier: string;
  service: string;
  amount: number;
  currency: string;
  deliveryDays: number | null;
}

export interface PurchasedLabel {
  shipmentId: string;
  trackingNumber: string;
  carrier: string;
  service: string;
  amount: number;
  currency: string;
  // ShipSaving v2 serves PNG label files; the stub keeps serving PDF — the
  // upload path carries whichever it got.
  labelData: Uint8Array;
  labelContentType: string;
  labelExt: string;
  trackingUrl: string | null;
}

export interface TrackingInfo {
  // Provider status string, stored verbatim for display.
  raw: string;
  // 'voided' covers a label cancelled outside this app (e.g. the ShipSaving
  // dashboard) — the row is marked, but fees are only reversed by our /void.
  normalized: 'purchased' | 'in_transit' | 'delivered' | 'exception' | 'voided';
  eta: Date | null;
}

// Context the buy call needs beyond the rate id: platformUkId is our shipment
// id (ShipSaving v2's idempotency key — a retry returns the existing label
// instead of double-charging), and quote is the stored rate the id resolved
// to (v2's buy response doesn't echo carrier/service).
export interface BuyContext {
  platformUkId: string;
  quote: RateQuote | null;
}

// Either handle identifies the shipment to void in v2; tracking number no
// longer does.
export interface VoidRef {
  shipmentNo: string | null;
  platformUkId: string | null;
}

export interface ShippingClient {
  provider: ShippingProvider;
  listRates(from: ShipAddress, to: ShipAddress, pkg: ShipPackage): Promise<RateQuote[]>;
  buyByRateId(rateId: string, ctx: BuyContext): Promise<PurchasedLabel>;
  voidLabel(ref: VoidRef): Promise<{ ok: boolean; message?: string }>;
  // carrier is required by ShipSaving v2's tracking endpoint; null falls back
  // to a best-effort call (the stub ignores it entirely).
  getShipment(trackingNumber: string, carrier: string | null): Promise<TrackingInfo>;
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
