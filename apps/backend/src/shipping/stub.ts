// Deterministic offline tracking source: every number is "in transit, three
// days out". Lets the package flow run in dev and tests with no Shippo token.

import type { TrackingInfo, TrackingSource } from './types';

export const stubTrackingSource: TrackingSource = {
  async getShipment(): Promise<TrackingInfo> {
    return {
      raw: 'IN_TRANSIT',
      normalized: 'in_transit',
      eta: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    };
  },
};
