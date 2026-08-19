// ShipSaving Legacy API v1 client — the ONLY file that knows ShipSaving wire
// shapes, so the sandbox-verification pass (once the API token exists) touches
// nothing else.
//
// PROVISIONAL: the public docs list endpoints and auth but not full JSON
// schemas. Field mapping below follows the documented Postman collection
// conventions and MUST be verified against the sandbox before the real
// provider is enabled in production. Every response passes through a parse*
// gate that throws on surprises; routes convert throws to 502.

import type { Env } from '../types';
import type { PurchasedLabel, RateQuote, ShipAddress, ShipPackage, ShippingClient, TrackingInfo } from './types';
import { carrierTrackingUrl } from './types';

const TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function shipSavingClient(env: Env): ShippingClient {
  const base = (env.SHIPSAVING_API_URL ?? '').replace(/\/+$/, '');
  const token = env.SHIPSAVING_API_TOKEN ?? '';

  async function call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(base + path, init);
    const data = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok || data === null) {
      const detail = data && typeof data.message === 'string' ? `: ${data.message}` : '';
      throw new Error(`shipsaving: ${method} ${path} returned ${res.status}${detail}`);
    }
    return data;
  }

  function toWireAddress(a: ShipAddress): Json {
    return {
      name: a.name,
      phone: a.phone ?? undefined,
      street1: a.street1,
      street2: a.street2 ?? undefined,
      city: a.city,
      state: a.state,
      zip: a.zip,
      country: a.country,
    };
  }

  function parseRate(raw: unknown): RateQuote {
    const r = raw as Json;
    const rateId = str(r.rate_id) ?? str(r.id);
    const carrier = str(r.carrier);
    const service = str(r.service) ?? str(r.service_name);
    const amount = num(r.amount) ?? num(r.rate) ?? num(r.total_amount);
    if (!rateId || !carrier || !service || amount === null) {
      throw new Error('shipsaving: unexpected rate shape in /api/rates/list response');
    }
    return {
      rateId,
      carrier,
      service,
      amount,
      currency: str(r.currency) ?? 'USD',
      deliveryDays: num(r.delivery_days) ?? num(r.estimated_days),
    };
  }

  async function fetchLabelPdf(r: Json): Promise<Uint8Array> {
    // Two documented-adjacent delivery styles; which one v1 actually uses is
    // confirmed against sandbox. Both are handled so only this helper changes.
    const url = str(r.label_url) ?? str(r.label_pdf_url);
    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`shipsaving: label download returned ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    const b64 = str(r.label_pdf) ?? str(r.label_base64);
    if (b64) return new Uint8Array(Buffer.from(b64, 'base64'));
    throw new Error('shipsaving: buy response carries neither a label URL nor label bytes');
  }

  return {
    provider: 'shipsaving',

    async listRates(from: ShipAddress, to: ShipAddress, pkg: ShipPackage): Promise<RateQuote[]> {
      const data = await call('POST', '/api/rates/list', {
        from_address: toWireAddress(from),
        to_address: toWireAddress(to),
        package: {
          weight: pkg.weightOz,
          weight_unit: 'oz',
          length: pkg.lengthIn,
          width: pkg.widthIn,
          height: pkg.heightIn,
          dimension_unit: 'in',
        },
      });
      const rates = Array.isArray(data.rates) ? data.rates : Array.isArray(data.data) ? data.data : null;
      if (!rates) throw new Error('shipsaving: unexpected /api/rates/list response');
      return rates.map(parseRate);
    },

    async buyByRateId(rateId: string): Promise<PurchasedLabel> {
      const data = await call('GET', `/api/rates/buy?rate_id=${encodeURIComponent(rateId)}`);
      const r = (data.shipment ?? data.data ?? data) as Json;
      const trackingNumber = str(r.tracking_number);
      const carrier = str(r.carrier);
      const service = str(r.service) ?? str(r.service_name);
      const amount = num(r.amount) ?? num(r.rate) ?? num(r.total_amount);
      if (!trackingNumber || !carrier || !service || amount === null) {
        throw new Error('shipsaving: unexpected /api/rates/buy response');
      }
      return {
        shipmentId: str(r.shipment_id) ?? str(r.id) ?? trackingNumber,
        trackingNumber,
        carrier,
        service,
        amount,
        currency: str(r.currency) ?? 'USD',
        labelPdf: await fetchLabelPdf(r),
        trackingUrl: str(r.tracking_url) ?? carrierTrackingUrl(carrier, trackingNumber),
      };
    },

    async voidLabel(trackingNumber: string): Promise<{ ok: boolean; message?: string }> {
      try {
        const data = await call('POST', '/api/shipments/void', { tracking_number: trackingNumber });
        const ok = data.success === true || data.status === 'success' || data.voided === true;
        return { ok, message: str(data.message) ?? undefined };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'void failed' };
      }
    },

    async getShipment(trackingNumber: string): Promise<TrackingInfo> {
      const data = await call('GET', `/api/shipments/get?tracking_number=${encodeURIComponent(trackingNumber)}`);
      const r = (data.shipment ?? data.data ?? data) as Json;
      const raw = str(r.tracking_status) ?? str(r.status) ?? 'UNKNOWN';
      const s = raw.toUpperCase().replace(/[\s-]+/g, '_');
      const normalized: TrackingInfo['normalized'] = s.includes('DELIVER')
        ? 'delivered'
        : s.includes('EXCEPTION') || s.includes('ALERT') || s.includes('FAIL')
          ? 'exception'
          : s.includes('TRANSIT') || s.includes('ACCEPT') || s.includes('OUT_FOR')
            ? 'in_transit'
            : 'purchased';
      const etaRaw = str(r.estimated_delivery_date) ?? str(r.eta);
      const eta = etaRaw ? new Date(etaRaw) : null;
      return { raw, normalized, eta: eta && !Number.isNaN(eta.getTime()) ? eta : null };
    },
  };
}
