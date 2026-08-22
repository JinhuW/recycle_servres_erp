import type { Env } from '../types';
import type { ShippingClient } from './types';
import { shipSavingClient } from './shipsaving';
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
} from './types';
export { carrierTrackingUrl } from './types';

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
