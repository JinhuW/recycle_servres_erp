import type { Env } from '../types';
import type { ShippingClient, TrackingSource as TrackingSourceT } from './types';
import type { ShippoClient as ShippoClientT } from './shippo';
import { shipSavingClient } from './shipsaving';
import { shippoClient } from './shippo';
import { stubShippingClient } from './stub';
import { log } from '../lib/log';

const shipLog = log.child({ module: 'shipping' });

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
    shipLog.warn(
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
let warnedAboutTrackingConfig = false;

export function pickTrackingClient(env: Env): TrackingChoice {
  if (env.SHIPPO_API_TOKEN) {
    // Both of these look healthy from the outside and are invisible in the UI:
    // without the secret every push 404s while the rows claim to be subscribed,
    // and a test token 400s every call (see
    // docs/debug-notes/2026-08-27-shippo-test-token-only-tracks-test-carrier.md).
    // Said once at boot so a deploy missing half the credentials is greppable.
    if (!warnedAboutTrackingConfig) {
      warnedAboutTrackingConfig = true;
      if (!env.SHIPPO_WEBHOOK_SECRET) {
        shipLog.warn(
          '[shipping] SHIPPO_API_TOKEN is set but SHIPPO_WEBHOOK_SECRET is not — numbers will be registered with Shippo and every push it sends will 404. Set the secret and point the Shippo dashboard at /api/public/shippo/<secret> on the public hostname.',
        );
      }
      if (env.SHIPPO_API_TOKEN.startsWith('shippo_test_')) {
        shipLog.warn(
          '[shipping] SHIPPO_API_TOKEN is a TEST token — it only tracks the `shippo` demo carrier and 400s every real UPS/FedEx/USPS number. Tracking will look configured and move nothing.',
        );
      }
    }
    const c = shippoClient(env);
    return { provider: 'shippo', source: c, register: c };
  }
  if (env.SHIPSAVING_APP_KEY && env.SHIPSAVING_APP_SECRET) {
    return { provider: 'shipsaving', source: shipSavingClient(env), register: null };
  }
  if (!warnedAboutTrackingStub) {
    warnedAboutTrackingStub = true;
    shipLog.warn(
      '[shipping] SHIPPO_API_TOKEN is not set and ShipSaving is unconfigured — tracking is STUBBED. Packages and shipments will never move on their own. Set SHIPPO_API_TOKEN to track externally-bought labels.',
    );
  }
  return { provider: 'stub', source: stubShippingClient, register: null };
}

// What /api/health reports. A stubbed deployment looks entirely healthy from
// outside — labels are "bought", rows are written, nothing errors — and packages
// simply never move, which is only discoverable by reading boot logs nobody
// reads. This makes the mode answerable over HTTP.
//
// Mirrors the conditions above without constructing a client or tripping their
// one-shot warnings; a probe must stay side-effect free. Change one, change both.
// Modes only — never credential values, and never more than set/unset.
export function describeShipping(env: Env): {
  labels: 'shipsaving' | 'stub';
  tracking: 'shippo' | 'shipsaving' | 'stub';
} {
  const shipSaving = Boolean(env.SHIPSAVING_APP_KEY && env.SHIPSAVING_APP_SECRET);
  return {
    labels: shipSaving ? 'shipsaving' : 'stub',
    tracking: env.SHIPPO_API_TOKEN ? 'shippo' : shipSaving ? 'shipsaving' : 'stub',
  };
}
