// Shippo Tracking API client — docs.goshippo.com, api.goshippo.com.
//
// Tracking only. Shippo tracks any carrier's number without owning the label,
// which is the whole point of it here: packages keep moving while labels are
// still on the stub. Rates, purchase and void stay with the ShippingClient.
//
// Endpoint map:
//   register  POST /tracks/                        (carrier + tracking_number)
//   read      GET  /tracks/{carrier}/{tracking_no}
//
// Registering a number is what turns webhook pushes on for it. Shippo's docs
// are explicit that tracking webhooks are NOT idempotent and a number must be
// registered once — packages.tracking_registered_at is what enforces that.

import type { Env } from '../types';
import type { TrackingInfo, TrackingSource } from './types';
import { parseEta } from './types';

const DEFAULT_BASE = 'https://api.goshippo.com';
const TIMEOUT_MS = 20_000;

function base(env: Env): string {
  return (env.SHIPPO_API_URL ?? DEFAULT_BASE).replace(/\/$/, '');
}

async function call<T>(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base(env)}${path}`, {
    method,
    headers: {
      Authorization: `ShippoToken ${env.SHIPPO_API_TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`shippo ${method} ${path} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  return res.json() as Promise<T>;
}

// packages.carrier is held to three values by its CHECK, but shipments.carrier
// carries whatever the label provider called it ('DHL', or a raw ShipSaving
// carrier_code). An exhaustive map would throw on those every tick forever, so
// anything unmapped goes through lowercased — which is also how the `shippo`
// test carrier is reachable.
const CARRIER_TOKEN: Record<string, string> = {
  ups: 'ups',
  fedex: 'fedex',
  usps: 'usps',
  dhl: 'dhl_express',
  'dhl express': 'dhl_express',
};

export function carrierToken(carrier: string | null): string {
  const key = (carrier ?? '').trim().toLowerCase();
  return CARRIER_TOKEN[key] ?? key;
}

export function normalizeShippoStatus(raw: string): TrackingInfo['normalized'] {
  switch (raw.toUpperCase()) {
    case 'DELIVERED': return 'delivered';
    case 'TRANSIT': return 'in_transit';
    // Shippo has no status meaning "we cancelled the label" — RETURNED and
    // FAILURE are both "a human has to look at this box".
    case 'RETURNED':
    case 'FAILURE': return 'exception';
    // PRE_TRANSIT (label made, not scanned) and UNKNOWN (carrier has never
    // heard of it) both mean no movement.
    default: return 'purchased';
  }
}

// The status half of a Track object, wherever it came from — a GET here or a
// track_updated webhook body. One reader, so the poll and the push can never
// disagree about what a payload means.
//
// Every field is narrowed at runtime rather than typed: the webhook hands this
// an unvalidated body, and an optional-everything interface accepts any object
// vacuously. A renamed Shippo field would compile clean and silently degrade
// every push to "no movement"; a numeric status would throw inside .toUpperCase()
// and turn into a 500 Shippo then retries forever.
export function trackToInfo(track: Record<string, unknown>): TrackingInfo {
  const st = (typeof track.tracking_status === 'object' && track.tracking_status !== null
    ? track.tracking_status
    : {}) as Record<string, unknown>;
  const status = typeof st.status === 'string' ? st.status : '';
  const details = typeof st.status_details === 'string' ? st.status_details.trim() : '';
  return {
    // '' means "this payload carried no status" — the apply* writers COALESCE
    // it away rather than overwriting a good carrier string with a placeholder.
    raw: details || status,
    normalized: normalizeShippoStatus(status),
    eta: parseEta(typeof track.eta === 'string' ? track.eta : null),
  };
}

export interface ShippoClient extends TrackingSource {
  registerTracking(trackingNumber: string, carrier: string, metadata: string): Promise<void>;
}

// An empty token would build `/tracks//1Z999…`, which 404s on every tick
// forever behind the callers' per-row catch. Fail loudly instead — the same
// contract the ShipSaving client states for the same input.
function requireCarrier(carrier: string | null): string {
  const token = carrierToken(carrier);
  if (!token) throw new Error(`shippo tracking needs a carrier, got ${JSON.stringify(carrier)}`);
  return token;
}

export function shippoClient(env: Env): ShippoClient {
  return {
    async getShipment(trackingNumber: string, carrier: string | null): Promise<TrackingInfo> {
      const track = await call<Record<string, unknown>>(
        env, 'GET',
        `/tracks/${encodeURIComponent(requireCarrier(carrier))}/${encodeURIComponent(trackingNumber)}`,
      );
      return trackToInfo(track);
    },

    async registerTracking(trackingNumber: string, carrier: string, metadata: string): Promise<void> {
      await call(env, 'POST', '/tracks/', {
        carrier: requireCarrier(carrier),
        tracking_number: trackingNumber,
        metadata,
      });
    },
  };
}
