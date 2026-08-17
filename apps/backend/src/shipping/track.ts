// Best-effort tracking refresh. ShipSaving v1 has no webhook/event feed, so a
// poll loop (same shape as startFxRefreshLoop) asks the provider about every
// live purchased shipment and applies status moves through the shared guard
// table. Stub-provider deployments never tick — canned tracking data would
// just march demo rows to in_transit for no reason.

import type { Sql } from 'postgres';
import type { Env } from '../types';
import type { ShipmentStatus, ShippingClient } from './types';
import { canTransition } from './status';
import { pickShippingClient } from './index';

const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export async function refreshShipmentTracking(
  sql: Sql,
  client: ShippingClient,
): Promise<{ checked: number; updated: number }> {
  const rows = await sql<{ id: string; status: ShipmentStatus; tracking_number: string }[]>`
    SELECT id, status, tracking_number
    FROM shipments
    WHERE status IN ('purchased','in_transit','exception')
      AND tracking_number IS NOT NULL
      AND provider = 'shipsaving'
  `;
  let updated = 0;
  for (const row of rows) {
    try {
      const info = await client.getShipment(row.tracking_number);
      // 'purchased' from the carrier means "no movement yet" — refresh the
      // metadata but never regress the status machine.
      const next: ShipmentStatus | null =
        info.normalized !== row.status && canTransition(row.status, info.normalized)
          ? info.normalized
          : null;
      await sql`
        UPDATE shipments SET
          status          = ${next ?? row.status},
          tracking_status = ${info.raw},
          tracking_eta    = ${info.eta},
          last_tracked_at = NOW()
        WHERE id = ${row.id}
      `;
      if (next) updated++;
    } catch (err) {
      console.warn(`[shipping] tracking refresh failed for shipment ${row.id}; keeping previous state`, err);
    }
  }
  return { checked: rows.length, updated };
}

export function startShipmentTrackingLoop(sql: Sql, env: Env): { stop: () => void } {
  const client = pickShippingClient(env);
  if (client.provider === 'stub') return { stop: () => {} };
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await refreshShipmentTracking(sql, client);
    } catch (err) {
      console.warn('[shipping] tracking refresh pass failed', err);
    }
  };
  void tick();
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
