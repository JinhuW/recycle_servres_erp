import type { Env } from '../types';
import type { TrackingSource as TrackingSourceT } from './types';
import type { ShippoClient as ShippoClientT } from './shippo';
import { shippoClient } from './shippo';
import { stubTrackingSource } from './stub';
import { log } from '../lib/log';

const shipLog = log.child({ module: 'shipping' });

export type { PackageStatus, TrackingInfo, TrackingSource } from './types';
export { carrierTrackingUrl, parseEta } from './types';

// Unlike OCR there is no prod boot-refusal: credentials may lag deploys and
// deploys must not block on them. A deployment without a token simply never
// ticks.
export type TrackingChoice =
  | { provider: 'shippo'; source: TrackingSourceT; register: ShippoClientT }
  | { provider: 'stub'; source: TrackingSourceT; register: null };

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
  if (!warnedAboutTrackingStub) {
    warnedAboutTrackingStub = true;
    shipLog.warn(
      '[shipping] SHIPPO_API_TOKEN is not set — tracking is STUBBED. Packages will never move on their own. Set SHIPPO_API_TOKEN to track externally-bought labels.',
    );
  }
  return { provider: 'stub', source: stubTrackingSource, register: null };
}

// What /api/health reports. A stubbed deployment looks entirely healthy from
// outside — rows are written, nothing errors — and packages simply never move,
// which is only discoverable by reading boot logs nobody reads. This makes the
// mode answerable over HTTP.
//
// Mirrors the condition above without constructing a client or tripping its
// one-shot warning; a probe must stay side-effect free. Change one, change both.
// Modes only — never credential values, and never more than set/unset.
export function describeShipping(env: Env): { tracking: 'shippo' | 'stub' } {
  return { tracking: env.SHIPPO_API_TOKEN ? 'shippo' : 'stub' };
}
