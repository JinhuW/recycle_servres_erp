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
import { pickShippingClient, pickTrackingClient } from './index';
import type { ShippoClient } from './shippo';
import { advanceOrderTx } from '../services/orderAdvance';
import { voidShipmentTx } from '../services/shipmentVoid';
import { notify } from '../lib/notify';
import { log } from '../lib/log';

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

// Both writers below COALESCE the two metadata columns rather than assigning
// them: a push can carry a tracking number and nothing else (routine for USPS,
// and what Shippo's "send test webhook" emits), and writing that straight
// through would blank an "Out for delivery" headline and its ETA.
//
// The row is re-read under a lock rather than trusted from the caller. Three
// writers land here now — the webhook push, the bench's manual refresh, and the
// poll — and a transition computed from a snapshot taken seconds ago would write
// a stale status back over a fresher one, bypassing canTransition entirely.
//
// Status move and its consequences commit together: a transition the metadata
// UPDATE persisted but whose PO advance / fee reversal failed would never be
// retried — `next` is null on every later tick.
export async function applyShipmentTracking(
  sql: Sql,
  row: Pick<TrackedShipmentRow, 'id'>,
  info: TrackingInfo,
): Promise<ShipmentStatus | null> {
  return sql.begin(async (tx): Promise<ShipmentStatus | null> => {
    const cur = (await tx`
      SELECT id, order_id, status, tracking_number, carrier
      FROM shipments WHERE id = ${row.id} LIMIT 1 FOR UPDATE
    `)[0] as TrackedShipmentRow | undefined;
    // Gone between the caller's read and this lock.
    if (!cur) return null;
    const next = nextStatus(cur.status, info);

    if (next === 'voided') {
      // Label cancelled outside the app (e.g. the ShipSaving dashboard):
      // marking the row voided makes our /void route unreachable, so the
      // fee reversal has to ride along here or the label cost stays baked
      // into the PO's other_fees forever.
      await voidShipmentTx(tx, {
        orderId: cur.order_id,
        sid: cur.id,
        trackingNumber: cur.tracking_number,
        carrier: cur.carrier,
        actor: null,
      });
    }
    await tx`
      UPDATE shipments SET
        status          = ${next ?? cur.status},
        tracking_status = COALESCE(NULLIF(${info.raw}, ''), tracking_status),
        tracking_eta    = COALESCE(${info.eta}, tracking_eta),
        last_tracked_at = NOW()
      WHERE id = ${cur.id}
    `;
    // The confirmed business rule, applied server-side: carrier movement
    // moves a Draft PO to In Transit. The system actor is held to exactly
    // that one transition, so a PO in any later stage is a quiet no-op.
    if (next === 'in_transit' || next === 'delivered') {
      const outcome = await advanceOrderTx(tx, cur.order_id, null);
      // A stage this actor may not drive is the quiet no-op above. A missing
      // transaction id is not: the goods moved, the PO cannot follow them, and
      // only a human adding the id un-sticks it. Unlogged, the rule looks like
      // it simply stopped applying.
      if (outcome.kind === 'missingTxnId') {
        log.warn('carrier movement could not advance the PO', {
          orderId: cur.order_id,
          shipmentId: cur.id,
          trackingNumber: cur.tracking_number,
          status: next,
        });
      }
    }
    return next;
  });
}

export async function applyPackageTracking(
  sql: Sql,
  row: Pick<TrackedPackageRow, 'id'>,
  info: TrackingInfo,
): Promise<ShipmentStatus | null> {
  return sql.begin(async (tx): Promise<ShipmentStatus | null> => {
    const cur = (await tx`
      SELECT id, status, tracking_number, carrier, created_by
      FROM packages WHERE id = ${row.id} LIMIT 1 FOR UPDATE
    `)[0] as TrackedPackageRow | undefined;
    if (!cur) return null;
    // Externally-voided doesn't exist for a package row (its CHECK holds the
    // 4-value tracked vocabulary) — treat it as no movement.
    const next = info.normalized === 'voided' ? null : nextStatus(cur.status, info);

    await tx`
      UPDATE packages SET
        status          = ${next ?? cur.status},
        tracking_status = COALESCE(NULLIF(${info.raw}, ''), tracking_status),
        tracking_eta    = COALESCE(${info.eta}, tracking_eta),
        last_tracked_at = NOW()
      WHERE id = ${cur.id}
    `;
    // Delivery is the moment the row wants a human: the PO is created
    // from the delivered box (create-po), so tell whoever added it.
    if (next === 'delivered' && cur.created_by) {
      await notify(tx, {
        userId: cur.created_by,
        kind: 'package_delivered',
        tone: 'pos',
        icon: 'package',
        title: `Package delivered — ${cur.carrier} ${cur.tracking_number}`,
        body: 'Create its purchase order from the Shipping page.',
      });
    }
    return next;
  });
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

// Registration is what turns webhook pushes on for a number, and the stamp is
// what stops it happening twice: Shippo's docs are explicit that tracking
// webhooks are NOT idempotent, so a second registration means two update
// streams for one box. Returns whether the number is now subscribed; a failure
// leaves the stamp NULL so the sweep below retries it.
export async function registerPackageTracking(
  sql: Sql,
  client: Pick<ShippoClient, 'registerTracking'>,
  pkg: { id: string; tracking_number: string; carrier: string },
): Promise<boolean> {
  try {
    await client.registerTracking(pkg.tracking_number, pkg.carrier, `package ${pkg.id}`);
    await sql`UPDATE packages SET tracking_registered_at = NOW() WHERE id = ${pkg.id}`;
    return true;
  } catch (err) {
    console.warn(`[shipping] tracking registration failed for package ${pkg.id}; the sweep will retry`, err);
    return false;
  }
}

// One registration is one awaited HTTP call with a 20s timeout, and this runs
// ahead of both refresh passes — so the batch is bounded rather than "every
// unregistered row". A token the provider rejects (an expired key, or the
// test-token trap in docs/debug-notes/2026-08-27-…) fails every row forever;
// the bound is what keeps that from starving the refresh passes behind it.
const REGISTER_BATCH = 50;

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
    ORDER BY created_at
    LIMIT ${REGISTER_BATCH}
  `;
  let done = 0;
  for (const row of rows) {
    if (await registerPackageTracking(sql, client, row)) done++;
  }
  return done;
}

export function startShipmentTrackingLoop(sql: Sql, env: Env): { stop: () => void } {
  const tracking = pickTrackingClient(env);
  // Shipments carry the label provider's own numbers and its own vocabulary —
  // notably 'voided', which no Shippo status maps to. Asking Shippo about them
  // would make an externally-cancelled label unrecognisable, and its cost would
  // stay in the PO's other_fees forever. Packages are the opposite case: nobody
  // here bought those labels, so they go through whatever can track a stranger's
  // number.
  const labels = pickShippingClient(env);
  if (tracking.provider === 'stub' && labels.provider === 'stub') return { stop: () => {} };

  let stopped = false;
  // Ticks must not overlap: two passes reading the same `tracking_registered_at
  // IS NULL` set before either commits would register the same numbers twice.
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Registration first: a box subscribed on this tick starts getting
      // pushes immediately instead of waiting out another interval.
      if (tracking.register) await registerUntrackedPackages(sql, tracking.register);
      if (labels.provider !== 'stub') await refreshShipmentTracking(sql, labels);
      if (tracking.provider !== 'stub') await refreshPackageTracking(sql, tracking.source);
    } catch (err) {
      console.warn('[shipping] tracking refresh pass failed', err);
    } finally {
      running = false;
    }
  };
  // Deferred rather than fired inline so a stop() in the same turn cancels the
  // first pass outright instead of leaving it querying a database the caller
  // has already moved on from.
  const kick = setTimeout(tick, 0);
  kick.unref?.();
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(handle);
    },
  };
}
