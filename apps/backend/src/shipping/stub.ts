// Deterministic offline provider: canned rates, a minimal-but-valid PDF, and
// an always-in-transit tracking answer. Lets the whole label flow run in dev,
// tests, and demos with no ShipSaving account.

import type { PurchasedLabel, RateQuote, ShippingClient, TrackingInfo } from './types';
import { carrierTrackingUrl } from './types';

const STUB_RATES: RateQuote[] = [
  { rateId: 'stub-usps-priority', carrier: 'USPS', service: 'Priority Mail', amount: 12.45, currency: 'USD', deliveryDays: 2 },
  { rateId: 'stub-ups-ground', carrier: 'UPS', service: 'Ground', amount: 9.8, currency: 'USD', deliveryDays: 4 },
  { rateId: 'stub-fedex-home', carrier: 'FedEx', service: 'Home Delivery', amount: 11.2, currency: 'USD', deliveryDays: 3 },
];

// Smallest well-formed one-page PDF; opens in any viewer, prints blank.
const STUB_PDF = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 288 432]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

export const stubShippingClient: ShippingClient = {
  provider: 'stub',

  async listRates(): Promise<RateQuote[]> {
    return STUB_RATES.map((r) => ({ ...r }));
  },

  async buyByRateId(rateId: string): Promise<PurchasedLabel> {
    const rate = STUB_RATES.find((r) => r.rateId === rateId);
    if (!rate) throw new Error(`stub shipping: unknown rateId ${rateId}`);
    const digits = crypto.randomUUID().replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
    const trackingNumber = `STUB${digits}`;
    return {
      shipmentId: `stub-shipment-${crypto.randomUUID()}`,
      trackingNumber,
      carrier: rate.carrier,
      service: rate.service,
      amount: rate.amount,
      currency: rate.currency,
      labelData: STUB_PDF.slice(),
      labelContentType: 'application/pdf',
      labelExt: 'pdf',
      trackingUrl: carrierTrackingUrl(rate.carrier, trackingNumber),
    };
  },

  async voidLabel(): Promise<{ ok: boolean }> {
    return { ok: true };
  },

  async getShipment(): Promise<TrackingInfo> {
    return {
      raw: 'IN_TRANSIT',
      normalized: 'in_transit',
      eta: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    };
  },
};
