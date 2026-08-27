// Tracking refresh. Two ways in, one way through: Shippo pushes track_updated
// webhooks for registered package numbers (routes/shippoWebhook.ts) and a slow
// poll sweeps everything as the backstop — both land in the apply* functions
// below, so a push and a poll can never disagree about what a status move
// means. Deployments with no tracking credentials never tick: canned data would
// just march demo rows to in_transit for no reason.

import type { Sql } from 'postgres';
import type { Env } from '../types';
import type { ShipmentStatus, TrackingInfo, TrackingSource } from './types';
import { canTransition } from './status';
import { pickTrackingClient } from './index';
import type { ShippoClient } from './shippo';
import { advanceOrderTx } from '../services/orderAdvance';
import { voidShipmentTx } from '../services/shipmentVoid';
import { notify } from '../lib/notify';

const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export type TrackedShipmentRow = {
  id: string;
  order_id: string;
  status: ShipmentStatus;
  tracking_number: string;
  carrier: string | null;
};

export type TrackedPackageRow = {
  id: string;
  status: ShipmentStatus;
  tracking_number: string;
  carrier: string;
  created_by: string | null;
};

// 'purchased' from the carrier means "no movement yet" — refresh the metadata
// but never regress the status machine.
function nextStatus(current: ShipmentStatus, info: TrackingInfo): ShipmentStatus | null {
  return info.normalized !== current && canTransition(current, info.normalized)
    ? info.normalized
    : null;
}

export async function applyShipmentTracking(
  sql: Sql,
  row: TrackedShipmentRow,
  info: TrackingInfo,
): Promise<ShipmentStatus | null> {
  const next = nextStatus(row.status, info);
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
  return next;
}

export async function applyPackageTracking(
  sql: Sql,
  row: TrackedPackageRow,
  info: TrackingInfo,
): Promise<ShipmentStatus | null> {
  // Externally-voided doesn't exist for a package row (its CHECK holds the
  // 4-value tracked vocabulary) — treat it as no movement.
  const next = info.normalized === 'voided' ? null : nextStatus(row.status, info);
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
  return next;
}

export async function refreshShipmentTracking(
  sql: Sql,
  client: TrackingSource,
): Promise<{ checked: number; updated: number }> {
  // provider='shipsaving' only: stub-bought demo labels carry numbers no
  // carrier has ever heard of, and asking about them is pure noise.
  const rows = await sql<TrackedShipmentRow[]>`
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
      if (await applyShipmentTracking(sql, row, info)) updated++;
    } catch (err) {
      console.warn(`[shipping] tracking refresh failed for shipment ${row.id}; keeping previous state`, err);
    }
  }
  return { checked: rows.length, updated };
}

// Standalone packages carry externally-bought labels, so every active row is
// polled through whatever client is configured — there is no provider column
// to filter on.
export async function refreshPackageTracking(
  sql: Sql,
  client: TrackingSource,
): Promise<{ checked: number; updated: number }> {
  const rows = await sql<TrackedPackageRow[]>`
    SELECT id, status, tracking_number, carrier, created_by
    FROM packages
    WHERE status IN ('purchased','in_transit','exception')
  `;
  let updated = 0;
  for (const row of rows) {
    try {
      const info = await client.getShipment(row.tracking_number, row.carrier);
      if (await applyPackageTracking(sql, row, info)) updated++;
    } catch (err) {
      console.warn(`[shipping] tracking refresh failed for package ${row.id}; keeping previous state`, err);
    }
  }
  return { checked: rows.length, updated };
}

// Subscribes any package Shippo isn't pushing for yet. Covers rows added before
// Shippo was configured and any add-time registration that lost a network race;
// without it those boxes would only ever move on the 45-minute poll.
export async function registerUntrackedPackages(
  sql: Sql,
  client: Pick<ShippoClient, 'registerTracking'>,
): Promise<number> {
  const rows = await sql<{ id: string; tracking_number: string; carrier: string }[]>`
    SELECT id, tracking_number, carrier
    FROM packages
    WHERE tracking_registered_at IS NULL
      AND status IN ('purchased','in_transit','exception')
  `;
  let done = 0;
  for (const row of rows) {
    try {
      await client.registerTracking(row.tracking_number, row.carrier, `package ${row.id}`);
      await sql`UPDATE packages SET tracking_registered_at = NOW() WHERE id = ${row.id}`;
      done++;
    } catch (err) {
      console.warn(`[shipping] tracking registration failed for package ${row.id}`, err);
    }
  }
  return done;
}

export function startShipmentTrackingLoop(sql: Sql, env: Env): { stop: () => void } {
  const tracking = pickTrackingClient(env);
  if (tracking.provider === 'stub') return { stop: () => {} };
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      // Registration first: a box subscribed on this tick starts getting
      // pushes immediately instead of waiting out another interval.
      if (tracking.register) await registerUntrackedPackages(sql, tracking.register);
      await refreshShipmentTracking(sql, tracking.source);
      await refreshPackageTracking(sql, tracking.source);
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
