// The PO lifecycle advance, extracted from POST /api/orders/:id/advance so the
// shipping tracking poll can apply the confirmed business rule — carrier
// movement moves a Draft PO to In Transit — through the exact same guards,
// audit events, and line-status cascade as the route.
//
// Must run inside the caller's transaction: the lifecycle read, every guard,
// and all writes happen under one FOR UPDATE lock on the orders row.

import { writeOrderEvent } from './orderAudit';
import { notifyManagers } from '../lib/notify';
import type { SqlLike } from './orderAudit';

// Canonical lifecycle ordering. The workflow_stages table was removed; this
// map's key order (draft → in_transit → reviewing → done) is the source of
// truth, matching the frontend's WORKFLOW_STAGES.
export const LINE_STATUS_FOR_LIFECYCLE: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  done: 'Done',
};

// null actor = the system (tracking poll). It is held to the purchaser rule:
// only Draft → In Transit, never a stage jump.
export type AdvanceActor = { id: string; name: string; role: string } | null;

export type AdvanceOutcome =
  | { kind: 'notFound' }
  | { kind: 'forbidden'; msg: string }
  | { kind: 'badStage'; msg: string }
  | { kind: 'finalStage' }
  | { kind: 'committedLines'; offendingLineIds: string[] }
  | { kind: 'ok'; nextStageId: string };

// Lines of this order that sit at one of `lineStatuses` and are claimed by an
// open sell order. Moving them off that status leaves the sell order holding
// inventory validateSellLines rejects, so both the backward advance and the
// purchaser-edit revert refuse rather than strand it.
async function committedLineIds(
  tx: SqlLike,
  orderId: string,
  lineStatuses: string[],
): Promise<string[]> {
  const rows = await tx`
    SELECT DISTINCT ol.id
    FROM order_lines ol
    JOIN sell_order_lines sol ON sol.inventory_id = ol.id
    JOIN sell_orders so ON so.id = sol.sell_order_id
    WHERE ol.order_id = ${orderId}
      AND ol.status = ANY(${lineStatuses})
      AND so.status IN ('Draft', 'Shipped', 'Awaiting payment')
  ` as unknown as { id: string }[];
  return rows.map(r => r.id);
}

// Move every non-Sold line to `newLineStatus`, recording one inventory_events
// row per line that actually moved.
//
// 'Sold' is a terminal post-sale state, not a lifecycle stage — a PO
// re-advance/stage-jump must never resurrect a sold-out line.
// All CTEs see the snapshot from before the statement, so `targets`
// captures the pre-update status while `upd` applies the new one.
// (A separate post-UPDATE SELECT would always read the already-updated
// status, so `status IS DISTINCT FROM $new` would be universally false and
// zero audit rows would ever be written.)
async function cascadeLineStatusesTx(
  tx: SqlLike,
  orderId: string,
  actorId: string | null,
  newLineStatus: string,
): Promise<void> {
  await tx`
    WITH targets AS (
      SELECT id, status AS old_status
      FROM order_lines
      WHERE order_id = ${orderId} AND status <> 'Sold'
        AND status IS DISTINCT FROM ${newLineStatus}
      FOR UPDATE
    ),
    upd AS (
      UPDATE order_lines ol SET status = ${newLineStatus}
      FROM targets t WHERE ol.id = t.id
    )
    INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
    SELECT t.id, ${actorId}::uuid, 'status',
           jsonb_build_object('field','status','from',t.old_status,'to',${newLineStatus}::text)
    FROM targets t
  `;
}

export type RevertOutcome =
  | { kind: 'committedLines'; offendingLineIds: string[] }
  | { kind: 'ok'; from: string };

// A purchaser who changes a submitted PO puts it back in their own hands: the
// order returns to Draft and has to be re-submitted, so a manager never
// reviews a version that has since moved. The caller must already hold the
// orders row FOR UPDATE and have established that the order is past Draft.
//
// The `reverted` audit event is NOT written here — only the caller, after its
// own writes, knows both sides of the change set the event carries.
//
// A live shipment can pull the order straight back to In Transit on the next
// tracking poll (shipping/track.ts). That's intended: carrier movement is
// ground truth, the edits survive it, and the manager's review dialog keys off
// the event rather than the stage.
export async function revertOrderToDraftTx(
  tx: SqlLike,
  id: string,
  actor: AdvanceActor,
): Promise<RevertOutcome> {
  const cur = (await tx`SELECT lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { lifecycle: string } | undefined;
  if (!cur) return { kind: 'committedLines', offendingLineIds: [] };

  // 'Reviewing' joins 'Done' here, unlike the backward-advance guard: a
  // Reviewing line is already sellable, so dropping it to Draft breaks any
  // sell order that named it.
  const committed = await committedLineIds(tx, id, ['Done', 'Reviewing']);
  if (committed.length > 0) return { kind: 'committedLines', offendingLineIds: committed };

  await tx`UPDATE orders SET lifecycle = 'draft' WHERE id = ${id}`;
  await cascadeLineStatusesTx(tx, id, actor?.id ?? null, LINE_STATUS_FOR_LIFECYCLE.draft);
  return { kind: 'ok', from: cur.lifecycle };
}

export async function advanceOrderTx(
  tx: SqlLike,
  id: string,
  actor: AdvanceActor,
  toStage?: string,
): Promise<AdvanceOutcome> {
  const stages = Object.keys(LINE_STATUS_FOR_LIFECYCLE);

  const cur = (await tx`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!cur) return { kind: 'notFound' };

  const curIdx = stages.indexOf(cur.lifecycle);
  let nextStageId: string;
  if (toStage) {
    if (actor?.role !== 'manager') return { kind: 'forbidden', msg: 'Only managers can jump stages' };
    if (!stages.includes(toStage)) return { kind: 'badStage', msg: 'Unknown stage' };
    nextStageId = toStage;
  } else {
    if (curIdx < 0 || curIdx >= stages.length - 1) return { kind: 'finalStage' };
    nextStageId = stages[curIdx + 1];
  }
  // Purchaser (and the system) can only advance Draft → in_transit — but ANY
  // purchaser may, not just the PO's creator: whoever handles the goods
  // submits the order. Every other transition stays manager-only.
  if (actor?.role !== 'manager' && !(cur.lifecycle === 'draft' && nextStageId === 'in_transit')) {
    return { kind: 'forbidden', msg: 'Purchasers can only advance Draft to In Transit' };
  }

  // Guard: if the transition would move non-Sold lines away from Done status,
  // check whether any of those lines are committed to an open sell order.
  // Un-doing a Done line that a sell order depends on leaves it in a status
  // that validateSellLines rejects, making the sell order unpromotable/broken.
  const newLineStatus = LINE_STATUS_FOR_LIFECYCLE[nextStageId];
  if (newLineStatus && newLineStatus !== 'Done') {
    const committed = await committedLineIds(tx, id, ['Done']);
    if (committed.length > 0) {
      return { kind: 'committedLines', offendingLineIds: committed };
    }
  }
  await tx`UPDATE orders SET lifecycle = ${nextStageId} WHERE id = ${id}`;

  // PO-level audit: the Draft → In Transit transition is the "submitted"
  // baseline (snapshot of lineCount + totalCost); every subsequent advance
  // is an `advanced` event with from/to.
  if (cur.lifecycle === 'draft' && nextStageId === 'in_transit') {
    const snap = (await tx`
      SELECT COUNT(*)::int AS line_count,
             COALESCE(SUM(qty), 0)::int AS qty,
             COALESCE(SUM(qty * unit_cost), 0)::float AS total_cost
      FROM order_lines WHERE order_id = ${id}
    `)[0] as { line_count: number; qty: number; total_cost: number };
    await writeOrderEvent(tx, id, actor?.id ?? null, 'submitted', {
      lineCount: snap.line_count,
      qty: snap.qty,
      totalCost: snap.total_cost,
    });
  } else {
    await writeOrderEvent(tx, id, actor?.id ?? null, 'advanced', {
      from: cur.lifecycle,
      to: nextStageId,
    });
  }
  if (newLineStatus) {
    await cascadeLineStatusesTx(tx, id, actor?.id ?? null, newLineStatus);
  }
  // PRD §10: managers want to see when a purchaser finalises an order.
  // We fire this only on the first forward transition (Draft → In Transit)
  // so they aren't spammed during later manager-driven moves.
  if (nextStageId === 'in_transit') {
    await notifyManagers(tx, {
      kind: 'order_submitted',
      tone: 'info',
      icon: 'inventory',
      title: `Order ${id} submitted`,
      body: actor
        ? `${actor.name} advanced ${id} to In Transit`
        : `Carrier movement advanced ${id} to In Transit`,
    });
  }
  return { kind: 'ok', nextStageId };
}
