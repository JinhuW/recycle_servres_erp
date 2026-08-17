// Shipment status machine — the single allowed-transition table, shared by the
// routes (buy/void/delete guards) and the tracking poll (carrier-driven
// moves). Terminal states have empty sets.

import type { ShipmentStatus } from './types';

export const ALLOWED_TRANSITIONS: Record<ShipmentStatus, ReadonlySet<ShipmentStatus>> = {
  draft: new Set(['quoted']),
  // quoted → quoted is a re-quote after editing nothing rate-relevant.
  quoted: new Set(['quoted', 'purchased']),
  purchased: new Set(['in_transit', 'delivered', 'voided', 'exception']),
  in_transit: new Set(['delivered', 'voided', 'exception']),
  // Carrier exceptions recover (address fixed, redelivery) or end the shipment.
  exception: new Set(['in_transit', 'delivered', 'voided']),
  delivered: new Set([]),
  voided: new Set([]),
};

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}
