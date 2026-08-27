import type { Env } from '../types';
import type { ShippingClient, TrackingSource as TrackingSourceT } from './types';
import type { ShippoClient as ShippoClientT } from './shippo';
import { shipSavingClient } from './shipsaving';
import { shippoClient } from './shippo';
import { stubShippingClient } from './stub';

export type {
  RateQuote,
  PurchasedLabel,
  ShipAddress,
  ShipPackage,
  ShipmentStatus,
  ShippingClient,
  ShippingProvider,
  TrackingInfo,
  TrackingSource,
} from './types';
export { carrierTrackingUrl, parseEta } from './types';

let warnedAboutStub = false;

// Unlike OCR there is no prod boot-refusal: credentials may lag deploys and
// deploys must not block on them. Stub-bought rows carry provider='stub', so
// real and demo labels can never be confused.
export function pickShippingClient(env: Env): ShippingClient {
  if (env.SHIPSAVING_APP_KEY && env.SHIPSAVING_APP_SECRET) return shipSavingClient(env);
  if (!warnedAboutStub) {
    warnedAboutStub = true;
    console.warn(
      '[shipping] SHIPSAVING_APP_KEY / SHIPSAVING_APP_SECRET not set — using the STUB shipping provider. Rates and labels are canned demo data; no real labels are bought. Set both to enable ShipSaving v2.',
    );
  }
  return stubShippingClient;
}

// Tracking is picked separately from labels, and that separation is the point:
// Shippo tracks any carrier's number without owning the label, so packages move
// while ShipSaving is still unconfigured and labels are still stubbed. Same
// no-boot-refusal policy as above — a deployment with neither credential simply
// never ticks.
export type TrackingChoice =
  | { provider: 'shippo'; source: TrackingSourceT; register: ShippoClientT }
  | { provider: 'shipsaving' | 'stub'; source: TrackingSourceT; register: null };

let warnedAboutTrackingStub = false;

export function pickTrackingClient(env: Env): TrackingChoice {
  if (env.SHIPPO_API_TOKEN) {
    const c = shippoClient(env);
    return { provider: 'shippo', source: c, register: c };
  }
  if (env.SHIPSAVING_APP_KEY && env.SHIPSAVING_APP_SECRET) {
    return { provider: 'shipsaving', source: shipSavingClient(env), register: null };
  }
  if (!warnedAboutTrackingStub) {
    warnedAboutTrackingStub = true;
    console.warn(
      '[shipping] SHIPPO_API_TOKEN is not set and ShipSaving is unconfigured — tracking is STUBBED. Packages and shipments will never move on their own. Set SHIPPO_API_TOKEN to track externally-bought labels.',
    );
  }
  return { provider: 'stub', source: stubShippingClient, register: null };
}
