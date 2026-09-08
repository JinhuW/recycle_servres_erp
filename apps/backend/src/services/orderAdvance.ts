// The PO lifecycle advance, extracted from POST /api/orders/:id/advance so the
// shipping tracking poll can apply the confirmed business rule — carrier
// movement moves a Draft PO to In Transit — through the exact same guards,
// audit events, and line-status cascade as the route.
//
// Must run inside the caller's transaction: the lifecycle read, every guard,
// and all writes happen under one FOR UPDATE lock on the orders row.

import { writeOrderEvent } from './orderAudit';
import { notify, notifyManagers } from '../lib/notify';
import { companyPayTxnMissing } from './orderTxnRule';
import type { SqlLike } from './orderAudit';

// Canonical lifecycle ordering. The workflow_stages table was removed; this
// map's key order (draft → in_transit → reviewing → ready_to_pay → done) is
// the source of truth, matching the frontend's WORKFLOW_STAGES.
//
// Line status is the inventory model, not the PO's stage: every stock and
// sellable bucket reads 'Done' as "goods confirmed by review", and Ready to
// Pay is exactly that — review finished, only the commission still owed. So
// the two closing stages share the line status rather than inventing a fifth
// value every bucket would have to learn.
export const LINE_STATUS_FOR_LIFECYCLE: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  ready_to_pay: 'Done',
  done: 'Done',
};

// Stage labels as the UI shows them. The list endpoints derive `status` from
// this, never from the line status above, or Ready to Pay would read "Done".
export const LIFECYCLE_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  ready_to_pay: 'Ready to Pay',
  done: 'Done',
};

// The book closes when the review does: from Ready to Pay on, the figure is
// what the purchaser gets paid on, so lines, costs and ownership freeze.
export function isClosedBook(lifecycle: string): boolean {
  return lifecycle === 'ready_to_pay' || lifecycle === 'done';
}

// Stages whose entry belongs to the PO's warehouse manager. A move from an
// earlier stage into one of these — or past it in a stage-jump — is theirs
// alone; once the order sits at or beyond it, any manager may continue, and
// backward moves are never gated. Gating another stage is one entry here.
const WAREHOUSE_MANAGER_GATED = new Set(['reviewing', 'ready_to_pay']);

function crossesGatedStage(stages: string[], fromIdx: number, toIdx: number): boolean {
  return stages.some((s, g) => WAREHOUSE_MANAGER_GATED.has(s) && fromIdx < g && toIdx >= g);
}

// null actor = the system (tracking poll). It is held to the purchaser rule:
// only Draft → In Transit, never a stage jump.
export type AdvanceActor = { id: string; name: string; role: string } | null;

export type AdvanceOutcome =
  | { kind: 'notFound' }
  | { kind: 'forbidden'; msg: string }
  | { kind: 'badStage'; msg: string }
  | { kind: 'finalStage' }
  | { kind: 'committedLines'; offendingLineIds: string[] }
  | { kind: 'transferClaimed'; offendingLineIds: string[] }
  | { kind: 'missingTxnId' }
  | { kind: 'ok'; nextStageId: string };

// Line statuses in lifecycle order, so a cascade can tell which lines it would
// move BACKWARDS. A committed line may never go backwards — not even from Done
// to Reviewing, which validateSellLines would still accept: a sell order raised
// against confirmed stock must not find it unconfirmed again.
// Deduped: two stages share 'Done', and a repeated value would make
// statusesAheadOf('Done') claim Done lines move backwards on a Ready to Pay ↔
// Done move, refusing it whenever a Done line sits on an open sell order.
const LINE_STATUS_ORDER = [...new Set(Object.values(LINE_STATUS_FOR_LIFECYCLE))];

function statusesAheadOf(lineStatus: string): string[] {
  const i = LINE_STATUS_ORDER.indexOf(lineStatus);
  return i < 0 ? [] : LINE_STATUS_ORDER.slice(i + 1);
}

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

// Lines this order has out on an open transfer order. Receive looks for them
// at 'In Transit'; cascading them anywhere else strands the transfer order —
// receive then marks it Received having moved nothing, and both discard
// (wants 'In Transit') and reopen (wants 'Done') refuse it forever.
async function transferClaimedLineIds(tx: SqlLike, orderId: string): Promise<string[]> {
  const rows = await tx`
    SELECT ol.id
    FROM order_lines ol
    JOIN transfer_orders t ON t.id = ol.transfer_order_id
    WHERE ol.order_id = ${orderId}
      AND ol.status = 'In Transit'
      AND t.status = 'Pending'
  ` as unknown as { id: string }[];
  return rows.map(r => r.id);
}

// Every guard a status cascade has to clear, for both the backward advance and
// the purchaser-edit revert. Returns null when the cascade is safe.
async function cascadeBlockers(
  tx: SqlLike,
  orderId: string,
  newLineStatus: string,
): Promise<{ kind: 'committedLines' | 'transferClaimed'; offendingLineIds: string[] } | null> {
  const movingBack = statusesAheadOf(newLineStatus);
  if (movingBack.length > 0) {
    const committed = await committedLineIds(tx, orderId, movingBack);
    if (committed.length > 0) return { kind: 'committedLines', offendingLineIds: committed };
  }
  if (newLineStatus !== 'In Transit') {
    const claimed = await transferClaimedLineIds(tx, orderId);
    if (claimed.length > 0) return { kind: 'transferClaimed', offendingLineIds: claimed };
  }
  return null;
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
  | { kind: 'transferClaimed'; offendingLineIds: string[] }
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
// `fromLifecycle` comes from the caller's own locked read rather than a
// re-SELECT here: the caller has it, and re-reading forced a "missing order"
// branch that could only report itself as a committed-line conflict.
export async function revertOrderToDraftTx(
  tx: SqlLike,
  id: string,
  actor: AdvanceActor,
  fromLifecycle: string,
): Promise<RevertOutcome> {
  const blocked = await cascadeBlockers(tx, id, LINE_STATUS_FOR_LIFECYCLE.draft);
  if (blocked) return blocked;

  await tx`UPDATE orders SET lifecycle = 'draft' WHERE id = ${id}`;
  await cascadeLineStatusesTx(tx, id, actor?.id ?? null, LINE_STATUS_FOR_LIFECYCLE.draft);
  // The forward half of this transition notifies; so must the reverse, or a
  // manager mid-review is never told the order left their queue. The review
  // dialog alone only fires if they happen to reopen that exact order.
  await notifyManagers(tx, {
    kind: 'order_reverted',
    tone: 'warn',
    icon: 'inventory',
    title: `Order ${id} back to Draft`,
    body: actor
      ? `${actor.name} changed ${id} after submitting it`
      : `${id} was changed after submission`,
  });
  return { kind: 'ok', from: fromLifecycle };
}

export async function advanceOrderTx(
  tx: SqlLike,
  id: string,
  actor: AdvanceActor,
  toStage?: string,
): Promise<AdvanceOutcome> {
  const stages = Object.keys(LINE_STATUS_FOR_LIFECYCLE);

  const cur = (await tx`
    SELECT user_id, lifecycle, payment, paypal_txn_id, created_at, warehouse_id
    FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE`)[0] as
    | { user_id: string; lifecycle: string; payment: string;
        paypal_txn_id: string | null; created_at: Date; warehouse_id: string | null } | undefined;
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

  // Only the warehouse's own manager takes the order into review, and on to
  // Ready to Pay: they are the one who saw the goods. No warehouse, or a
  // warehouse whose manager is unassigned, demoted or deactivated, leaves the
  // move to any manager — a gate nobody can pass is a stuck order, not a rule.
  // The message names the stage that was asked for, not the gate that tripped.
  if (cur.warehouse_id && crossesGatedStage(stages, curIdx, stages.indexOf(nextStageId))) {
    const wh = (await tx`
      SELECT w.short, w.manager_user_id, mu.name AS manager_name
      FROM warehouses w
      LEFT JOIN users mu ON mu.id = w.manager_user_id
                        AND mu.role = 'manager' AND COALESCE(mu.active, TRUE)
      WHERE w.id = ${cur.warehouse_id} LIMIT 1
    `)[0] as { short: string; manager_user_id: string | null; manager_name: string | null } | undefined;
    if (wh?.manager_name && wh.manager_user_id !== actor?.id) {
      return {
        kind: 'forbidden',
        msg: `Only ${wh.manager_name} (${wh.short} manager) can move this order to ${LIFECYCLE_LABEL[nextStageId]}`,
      };
    }
  }

  // Guard: a company-paid PO leaves Draft only once it names the payment that
  // funded it. Held against every actor — a manager stage-jump and the carrier
  // poll included — because a rule the two commonest paths can route around is
  // not a rule. The id is also what auto-link matches on, so filling it is what
  // makes the PO reconcile itself later.
  if (cur.lifecycle === 'draft' && nextStageId !== 'draft'
      && await companyPayTxnMissing(tx, cur)) {
    return { kind: 'missingTxnId' };
  }

  // Guard: a cascade that moves lines off a sellable status breaks any sell
  // order that named them, and one that moves them off 'In Transit' strands an
  // open transfer order. Both refuse rather than corrupt the dependant.
  const newLineStatus = LINE_STATUS_FOR_LIFECYCLE[nextStageId];
  if (newLineStatus) {
    const blocked = await cascadeBlockers(tx, id, newLineStatus);
    if (blocked) return blocked;
  }
  await tx`UPDATE orders SET lifecycle = ${nextStageId} WHERE id = ${id}`;

  // PO-level audit: leaving Draft is the "submitted" baseline (snapshot of
  // lineCount + totalCost); every subsequent advance is an `advanced` event
  // with from/to. A manager stage-jump out of Draft counts — the order has
  // been submitted either way, and `everSubmitted` (which decides whether
  // delete or archive applies) reads exactly this.
  if (cur.lifecycle === 'draft' && nextStageId !== 'draft') {
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
  // PRD §10: managers want to see when a purchaser finalises an order. Only
  // the move into In Transit fires it, so later manager-driven moves don't
  // spam — but a re-submission after a purchaser edit does, deliberately:
  // that is a new version needing a new review.
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
  // Ready to Pay is the moment money is owed: the payer needs to know, and so
  // does the purchaser it is owed to. Only forward entry fires it — a Done →
  // Ready to Pay reopen is a correction, not a new payable.
  if (nextStageId === 'ready_to_pay' && curIdx < stages.indexOf('ready_to_pay')) {
    const who = actor?.name ?? 'The system';
    const n = {
      kind: 'order_ready_to_pay',
      tone: 'pos' as const,
      icon: 'inventory',
      title: `Order ${id} ready to pay`,
      body: `${who} finished reviewing ${id} — the commission is payable`,
    };
    await notifyManagers(tx, n);
    await notify(tx, { userId: cur.user_id, ...n });
  }
  return { kind: 'ok', nextStageId };
}
