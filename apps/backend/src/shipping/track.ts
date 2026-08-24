// Best-effort tracking refresh. ShipSaving v2 has no webhook/event feed, so a
// poll loop (same shape as startFxRefreshLoop) asks the provider about every
// live purchased shipment and applies status moves through the shared guard
// table. Stub-provider deployments never tick — canned tracking data would
// just march demo rows to in_transit for no reason.

import type { Sql } from 'postgres';
import type { Env } from '../types';
import type { ShipmentStatus, ShippingClient } from './types';
import { canTransition } from './status';
import { pickShippingClient } from './index';
import { advanceOrderTx } from '../services/orderAdvance';
import { voidShipmentTx } from '../services/shipmentVoid';
import { notify } from '../lib/notify';

const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export async function refreshShipmentTracking(
  sql: Sql,
  client: ShippingClient,
): Promise<{ checked: number; updated: number }> {
  const rows = await sql<{ id: string; order_id: string; status: ShipmentStatus; tracking_number: string; carrier: string | null }[]>`
    SELECT id, order_id, status, tracking_number, carrier
    FROM shipments
    WHERE status IN ('purchased','in_transit','exception')
      AND tracking_number IS NOT NULL
      AND provider = 'shipsaving'
  `;
  let updated = 0;
  for (const row of rows) {
    try {
      const info = await client.getShipment(row.tracking_number, row.carrier);
      // 'purchased' from the carrier means "no movement yet" — refresh the
      // metadata but never regress the status machine.
      const next: ShipmentStatus | null =
        info.normalized !== row.status && canTransition(row.status, info.normalized)
          ? info.normalized
          : null;
      // Status move and its consequences commit together: a transition the
      // metadata UPDATE persisted but whose PO advance / fee reversal failed
      // would never be retried — `next` is null on every later tick.
      await sql.begin(async (tx) => {
        if (next === 'voided') {
          // Label cancelled outside the app (e.g. the ShipSaving dashboard):
          // marking the row voided makes our /void route unreachable, so the
          // fee reversal has to ride along here or the label cost stays baked
          // into the PO's other_fees forever.
          await voidShipmentTx(tx, {
            orderId: row.order_id,
            sid: row.id,
            trackingNumber: row.tracking_number,
            carrier: row.carrier,
            actor: null,
          });
        }
        await tx`
          UPDATE shipments SET
            status          = ${next ?? row.status},
            tracking_status = ${info.raw},
            tracking_eta    = ${info.eta},
            last_tracked_at = NOW()
          WHERE id = ${row.id}
        `;
        // The confirmed business rule, applied server-side: carrier movement
        // moves a Draft PO to In Transit. The system actor is held to exactly
        // that one transition, so a PO in any later stage is a quiet no-op.
        if (next === 'in_transit' || next === 'delivered') {
          await advanceOrderTx(tx, row.order_id, null);
        }
      });
      if (next) updated++;
    } catch (err) {
      console.warn(`[shipping] tracking refresh failed for shipment ${row.id}; keeping previous state`, err);
    }
  }
  return { checked: rows.length, updated };
}

// Standalone packages carry externally-bought labels, so every active row is
// polled through whatever client is configured — there is no provider column
// to filter on. Runs from the same loop; stub deployments never tick.
export async function refreshPackageTracking(
  sql: Sql,
  client: ShippingClient,
): Promise<{ checked: number; updated: number }> {
  const rows = await sql<{
    id: string; status: ShipmentStatus; tracking_number: string;
    carrier: string; created_by: string | null;
  }[]>`
    SELECT id, status, tracking_number, carrier, created_by
    FROM packages
    WHERE status IN ('purchased','in_transit','exception')
  `;
  let updated = 0;
  for (const row of rows) {
    try {
      const info = await client.getShipment(row.tracking_number, row.carrier);
      // Externally-voided doesn't exist for a package row (its CHECK holds the
      // 4-value tracked vocabulary) — treat it as no movement.
      const next: ShipmentStatus | null =
        info.normalized !== 'voided'
          && info.normalized !== row.status
          && canTransition(row.status, info.normalized)
          ? info.normalized
          : null;
      await sql.begin(async (tx) => {
        await tx`
          UPDATE packages SET
            status          = ${next ?? row.status},
            tracking_status = ${info.raw},
            tracking_eta    = ${info.eta},
            last_tracked_at = NOW()
          WHERE id = ${row.id}
        `;
        // Delivery is the moment the row wants a human: the PO is created
        // from the delivered box (create-po), so tell whoever added it.
        if (next === 'delivered' && row.created_by) {
          await notify(tx, {
            userId: row.created_by,
            kind: 'package_delivered',
            tone: 'pos',
            icon: 'package',
            title: `Package delivered — ${row.carrier} ${row.tracking_number}`,
            body: 'Create its purchase order from the Shipping page.',
          });
        }
      });
      if (next) updated++;
    } catch (err) {
      console.warn(`[shipping] tracking refresh failed for package ${row.id}; keeping previous state`, err);
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
      await refreshPackageTracking(sql, client);
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
