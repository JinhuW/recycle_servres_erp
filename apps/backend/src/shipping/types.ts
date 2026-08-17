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
  labelPdf: Uint8Array;
  trackingUrl: string | null;
}

export interface TrackingInfo {
  // Provider status string, stored verbatim for display.
  raw: string;
  normalized: 'purchased' | 'in_transit' | 'delivered' | 'exception';
  eta: Date | null;
}

export interface ShippingClient {
  provider: ShippingProvider;
  listRates(from: ShipAddress, to: ShipAddress, pkg: ShipPackage): Promise<RateQuote[]>;
  buyByRateId(rateId: string): Promise<PurchasedLabel>;
  voidLabel(trackingNumber: string): Promise<{ ok: boolean; message?: string }>;
  getShipment(trackingNumber: string): Promise<TrackingInfo>;
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
