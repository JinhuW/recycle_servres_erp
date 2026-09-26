// Package status machine — the single allowed-transition table for the
// carrier-driven moves applied by the tracking poll and the webhook.
// Terminal states have empty sets.

import type { PackageStatus } from './types';

const ALLOWED_TRANSITIONS: Record<PackageStatus, ReadonlySet<PackageStatus>> = {
  purchased: new Set(['in_transit', 'delivered', 'exception']),
  in_transit: new Set(['delivered', 'exception']),
  // Carrier exceptions recover (address fixed, redelivery) or end the trip.
  exception: new Set(['in_transit', 'delivered']),
  delivered: new Set([]),
};

export function canTransition(from: PackageStatus, to: PackageStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}
