import type postgres from 'postgres';
import { CLOSE_REASON_IDS } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { notify } from '../lib/notify';
import {
  committedSellStatuses, isSellableLineStatus, proposalSellStatuses,
} from '../lib/sellCommitment';
import { recordSaleDataPoints, retractSaleDataPoints, retractBidDataPoints, retractUnpricedBids } from '../lib/sellOrderMarket';
import type { WithdrawnPrice } from '../lib/refPriceEvents';
import { goodsTotalIsMirror, syncOrderGoodsTotal } from './orderGoodsTotal';
import { LINE_STATUS_FOR_LIFECYCLE } from './orderAdvance';
import { lockOrdersTx } from './orderLocks';
import { validateSellLines } from './sellOrderCreate';
import { writeSellOrderEvent } from './sellOrderAudit';
import { missingSigners, signoffState } from './sellOrderSignoff';

// Sell-order lifecycle. A transition may carry a note; files are evidence
// through the status-meta attachments endpoints, and only a reopen requires
// the note.
// Transitioning to Done also flips every underlying inventory line to Done
// and writes an audit row per line, so the inventory page stays in sync.
//
// Evidence is persisted on main's split schema (migration 0003): the text
// note lives on sell_order_status_meta (PK = sell_order_id+status, columns
// note/set_at/set_by); file evidence lives in its own table and is uploaded
// via the status-meta attachments endpoints in routes/sellOrders.ts.
// Transition map is the single source of truth for what status changes
// are legal. Any open stage can jump straight to Awaiting payment, to Done
// (the deal can be marked paid at any point), or to Closed. Done has exactly
// one outgoing edge, a reopen to Awaiting payment: the order hands back the
// stock it consumed and reserves it again, so nobody else takes it while the
// sale is corrected. Closed has exactly one outgoing edge (reopen → Draft) and
// cannot go to Done. Packing can step back to Draft — Pack mode moves a Draft
// there on opening, and a mistaken open must be undoable.
// Adding a new status means editing this map + the CHECK constraint + the
// seed — no parallel guards elsewhere ("Status guards" in
// apps/backend/AGENTS.md).
export const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  Draft:               new Set(['Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed']),
  Packing:             new Set(['Draft', 'Shipped', 'Awaiting payment', 'Done', 'Closed']),
  Shipped:             new Set(['Awaiting payment', 'Done', 'Closed']),
  'Awaiting payment':  new Set(['Done', 'Closed']),
  Done:                new Set(['Awaiting payment']),
  Closed:              new Set(['Draft']),
};
export const KNOWN_STATUSES = new Set<string>([
  'Draft', 'Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed',
]);
// Statuses that carry a per-status meta row (note + attachments). The DB
// row sell_order_statuses.needs_meta tracks the same idea for the per-status
// upload routes (those look it up dynamically); this set governs which
// transitions upsert a sell_order_status_meta row. Evidence is optional —
// the note/attachments are captured opportunistically, never required.
const META_STATUSES = new Set(['Shipped', 'Awaiting payment', 'Done', 'Closed']);

// Fixed close-reason taxonomy from @recycle-erp/shared (single source of
// truth, shared with the frontend picker). The SQL CHECK on
// sell_orders.close_reason_id (migration 0057) must list the same values;
// adding a reason means extending CLOSE_REASON_IDS and widening the CHECK.
export const CLOSE_REASONS = new Set<string>(CLOSE_REASON_IDS);

// Each PO the order's sold lines come from, with whether its goods total still
// mirrors its lines. Selling or un-selling moves qty, an input to that total,
// so the verdict has to be taken before the write — afterwards a stale mirror
// reads as a negotiated lot price and that PO's total_cost pins itself
// against its lines for good.
async function soldSourceGoodsVerdicts(tx: SqlLike, sellOrderId: string): Promise<Map<string, boolean>> {
  const sources = await tx<{ order_id: string }[]>`
    SELECT DISTINCT l.order_id
    FROM sell_order_lines sol
    JOIN order_lines l ON l.id = sol.inventory_id
    WHERE sol.sell_order_id = ${sellOrderId} AND sol.inventory_id IS NOT NULL AND sol.qty > 0
  `;
  const verdicts = new Map<string, boolean>();
  for (const o of sources) verdicts.set(o.order_id, await goodsTotalIsMirror(tx, o.order_id));
  return verdicts;
}

export type StatusMoveOutcome =
  | { kind: 'notFound' }
  | { kind: 'illegal'; from: string; to: string }
  | { kind: 'idempotent'; status: string }
  | { kind: 'moved'; status: string }
  | { kind: 'notCreator' }
  | { kind: 'reopenNeedsNote' }
  | { kind: 'conflict'; msg: string }
  | { kind: 'archived'; to: string }
  | { kind: 'needsSignoff'; missing: string[] }
  | { kind: 'done' };

export type StatusMove = { to: string; from?: string; note?: string; closeReasonId?: string };

// One sell-order status change, run inside the caller's transaction. POST
// /api/sell-orders/:id/status is the usual caller; a confirmed eBay sale takes
// the order it creates through here too, so the transition table and every
// gate below stay the one guard. The caller has validated `to`, `from` and the
// close reason against KNOWN_STATUSES / CLOSE_REASONS.
export async function moveSellOrderStatusTx(
  tx: postgres.TransactionSql, id: string, actorId: string, body: StatusMove,
): Promise<StatusMoveOutcome> {
  const hasNote = typeof body.note === 'string' && body.note.trim().length > 0;

  // Done rewrites every source PO (goods total, sold settlement), so those
  // orders are locked before this header: orders, then sell orders, then
  // lines is the one order every writer takes (services/orderLocks.ts).
  // Archive holds its PO and then locks the sell orders on it; taking the
  // header first here deadlocked against it (40P01 → 500). Reopening a sale
  // rewrites them too, and a reopen says so in `from`.
  let lockedSources: string[] = [];
  if (body.to === 'Done' || body.from === 'Done') {
    const owners = await tx<{ order_id: string }[]>`
      SELECT DISTINCT ol.order_id FROM sell_order_lines sol
      JOIN order_lines ol ON ol.id = sol.inventory_id
      WHERE sol.sell_order_id = ${id}
    `;
    lockedSources = owners.map((r) => r.order_id);
    await lockOrdersTx(tx, lockedSources);
  }
  const cur = (await tx<{
    status: string; created_by: string | null; archived_at: string | null; done_at: string | null;
  }[]>`
    SELECT status, created_by, archived_at, done_at FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
  `)[0];
  if (!cur) return { kind: 'notFound' };
  if (cur.status === body.to) return { kind: 'idempotent', status: cur.status };
  // `from` is the status the caller was looking at. A screen opened before
  // someone else moved the order must not carry out a move meant for the
  // order as it was.
  if (body.from !== undefined && body.from !== cur.status) return { kind: 'moved', status: cur.status };

  const allowed = ALLOWED_TRANSITIONS[cur.status] ?? new Set<string>();
  if (!allowed.has(body.to)) {
    return { kind: 'illegal', from: cur.status, to: body.to };
  }
  // An archived order is hidden from the inbox, so a reservation it staked
  // would hold stock nobody can see. Reopening an archived Closed order
  // lands in Draft, which is how one could otherwise get here.
  if (cur.archived_at !== null && committedSellStatuses().includes(body.to)) {
    return { kind: 'archived', to: body.to };
  }

  // Reopen (Closed → Draft) is creator-only. NULL created_by (MCP
  // client_credentials orders) falls through so those aren't permanently
  // bricked — any manager may reopen them. Checked before the note gate so
  // a non-creator gets 403, not a misleading "note required" 400.
  const reopening = cur.status === 'Closed' && body.to === 'Draft';
  if (reopening && cur.created_by !== null && cur.created_by !== actorId) {
    return { kind: 'notCreator' };
  }

  // Reopening a sale (Done → Awaiting payment) hands back the stock Done
  // consumed. Any manager may: every one of them signed the Done. It has to
  // be asked for by name: an ordinary save of an editor opened before the
  // order went Done posts the same move.
  const reopeningSale = cur.status === 'Done' && body.to === 'Awaiting payment';
  if (reopeningSale && body.from !== 'Done') {
    return { kind: 'conflict', msg: 'this order is Done now — reopen it to move it back to Awaiting payment' };
  }

  // A sale that was Done goes back to Done. Taking its goods back is an
  // after-sales return; closing it would leave its payments and cases on an
  // order that sold nothing.
  if (body.to === 'Closed' && cur.done_at !== null) {
    return { kind: 'conflict', msg: 'this sale was Done — mark it Done again, or open an after-sales case to take goods back' };
  }

  // A reopen needs a note, from Closed or from Done. These are the remaining
  // required-note rules: a fresh Draft creation doesn't need a note, so the
  // rule is "a transition *out of* Closed or Done needs a note", not "Draft
  // is a meta status".
  if ((reopening || reopeningSale) && !hasNote) {
    return { kind: 'reopenNeedsNote' };
  }

  // Lines held at 0 hold nothing; an order made only of them would ship,
  // bill or sell nothing. Checked on every move into those statuses, not
  // only out of Draft: a shipped order can be zeroed through PATCH.
  if (body.to === 'Shipped' || body.to === 'Awaiting payment' || body.to === 'Done') {
    const [{ any }] = await tx<{ any: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM sell_order_lines WHERE sell_order_id = ${id} AND qty > 0) AS any
    `;
    if (!any) return { kind: 'conflict', msg: 'every product on this order is at 0 — there is nothing to sell' };
  }

  // The source POs were read before this header was locked; a line moved
  // to another PO in between would need a lock this transaction can no
  // longer take in order, so it starts over rather than take it out of
  // order.
  if (body.to === 'Done' || reopeningSale) {
    const owners = await tx<{ order_id: string }[]>`
      SELECT DISTINCT ol.order_id FROM sell_order_lines sol
      JOIN order_lines ol ON ol.id = sol.inventory_id
      WHERE sol.sell_order_id = ${id}
    `;
    if (owners.some((r) => !lockedSources.includes(r.order_id))) {
      return { kind: 'conflict', msg: 'products on this order moved between purchase orders — try again' };
    }
  }

  // An open after-sales case is working from the sale as it stands, and the
  // first save of the reopened order rewrites the lines it points at.
  if (reopeningSale) {
    const [open] = await tx<{ id: string }[]>`
      SELECT id FROM after_sales_cases
      WHERE sell_order_id = ${id} AND closed_at IS NULL
      ORDER BY created_at LIMIT 1
    `;
    if (open) {
      return { kind: 'conflict', msg: `after-sales case ${open.id} is open on this sale — resolve or cancel it to reopen the sale` };
    }
  }

  // The units go back to the lots they came from, and the order holds them
  // again, so each lot must be one a committed order may hold — the rule
  // validateSellLines enforces on promotion, applied to the status the lot
  // will have. Checked before anything is written: a refusal returned here
  // still commits.
  const restored: { id: string; status: string; qty: number; back: number }[] = [];
  if (reopeningSale) {
    const lots = await tx<{
      id: string; order_id: string; product_no: number; status: string; qty: number;
      lifecycle: string; archived_at: string | null; took: number;
    }[]>`
      SELECT l.id, l.order_id, l.product_no, l.status, l.qty, o.lifecycle, o.archived_at, t.q AS took
      FROM order_lines l
      JOIN orders o ON o.id = l.order_id
      JOIN (
        SELECT inventory_id, SUM(qty)::int AS q FROM sell_order_lines
        WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL AND qty > 0
        GROUP BY inventory_id
      ) t ON t.inventory_id = l.id
      ORDER BY l.id
      FOR UPDATE OF l
    `;
    // Each lot's last sale, which is the one that sold it out if it is Sold,
    // and this order's own last sale of it.
    const sales = await tx<{
      line_id: string; last_seller: string | null; last_prior_status: string | null;
      own_prior_qty: number | null;
    }[]>`
      SELECT l.id AS line_id, last.detail->>'sellOrder' AS last_seller,
             last.detail->>'priorStatus' AS last_prior_status,
             (own.detail->>'priorQty')::int AS own_prior_qty
      FROM unnest(${lots.map(l => l.id)}::uuid[]) AS l(id)
      LEFT JOIN LATERAL (
        SELECT detail FROM inventory_events
        WHERE order_line_id = l.id AND kind = 'sold'
        ORDER BY created_at DESC LIMIT 1
      ) last ON TRUE
      LEFT JOIN LATERAL (
        SELECT detail FROM inventory_events
        WHERE order_line_id = l.id AND kind = 'sold' AND detail->>'sellOrder' = ${id}
        ORDER BY created_at DESC LIMIT 1
      ) own ON TRUE
    `;
    const saleOf = new Map(sales.map(r => [r.line_id, r]));
    for (const l of lots) {
      const ref = `${l.order_id} #${l.product_no}`;
      const sale = saleOf.get(l.id);
      const soldOut = l.status === 'Sold';
      // What the sale took: everything the order asked for, unless it sold
      // the lot out with more than was left. A sold-out lot kept the qty it
      // had before the sale that emptied it, which stands in for events
      // that predate priorQty.
      const prior = sale?.own_prior_qty
        ?? (soldOut && sale?.last_seller === id ? l.qty : null);
      const back = prior === null ? l.took : Math.min(l.took, prior);
      // A sold-out lot returns to the status it was sold from. Events that
      // predate priorStatus fall back to its PO's stage.
      const status = soldOut
        ? sale?.last_prior_status ?? LINE_STATUS_FOR_LIFECYCLE[l.lifecycle]
        : l.status;
      if (l.archived_at !== null) {
        return { kind: 'conflict', msg: `${ref} is on an archived order — unarchive it to reopen this sale` };
      }
      if (!isSellableLineStatus(status)) {
        return { kind: 'conflict', msg: `${ref} is not sellable (status=${status}), so its units can't go back to it` };
      }
      // Another sale may have emptied the lot after this one, so a sold-out
      // lot holds exactly what this order gives back.
      restored.push({ id: l.id, status, qty: soldOut ? back : l.qty + back, back });
    }
  }

  // Leaving the proposals (Draft, Packing) is where the order actually claims
  // its inventory, so it's where the one-committed-order-per-line rule is
  // enforced. Rivals may name the same line, and the qty a proposal was
  // written against may have been sold since, so both checks run here rather
  // than at create time. Closing claims nothing, and neither does moving
  // between the proposals.
  const proposals = proposalSellStatuses();
  if (proposals.includes(cur.status) && !proposals.includes(body.to) && body.to !== 'Closed') {
    const own = await tx<{ inventory_id: string | null; qty: number }[]>`
      SELECT inventory_id, qty FROM sell_order_lines WHERE sell_order_id = ${id}
    `;
    const err = await validateSellLines(
      tx,
      own.map(l => ({ inventoryId: l.inventory_id, qty: l.qty })),
      id,
    );
    if (err) return { kind: 'conflict', msg: err };
  }

  // Done needs every active manager's sign-off on the order as it stands.
  // Checked after the source POs are locked: a PO archive takes lines off
  // this order holding only the PO's lock, and the fingerprint has to see
  // that. Last, too, so any other refusal names its own reason.
  if (body.to === 'Done') {
    const missing = missingSigners((await signoffState(tx, id)).managers);
    if (missing.length > 0) return { kind: 'needsSignoff', missing: missing.map(m => m.name) };
  }

  // A reopen's reason also lands on the order itself as an appended notes
  // line — the events timeline alone is too easy to miss. Prior notes are
  // preserved; each reopen cycle appends its own line.
  const withReopenLine = () => {
    const line = `Reopened: ${body.note!.trim()}`;
    return tx`CASE WHEN notes IS NULL OR notes = '' THEN ${line} ELSE notes || ${'\n\n' + line} END`;
  };

  // Apply the status update + (for close) the denormalized reason; (for
  // reopen) clear the reason.
  if (body.to === 'Closed') {
    await tx`
      UPDATE sell_orders
         SET status = 'Closed',
             close_reason_id = ${body.closeReasonId!},
             updated_at = NOW()
       WHERE id = ${id}
    `;
  } else if (reopening) {
    await tx`
      UPDATE sell_orders
         SET status = 'Draft',
             close_reason_id = NULL,
             notes = ${withReopenLine()},
             updated_at = NOW()
       WHERE id = ${id}
    `;
    // A deal revived after it was closed is a new deal to approve, and a new
    // one to pack: ticks kept from before would let it ship with nothing
    // re-counted.
    await tx`DELETE FROM sell_order_signoffs WHERE sell_order_id = ${id}`;
    await tx`DELETE FROM sell_order_packs WHERE sell_order_id = ${id}`;
  } else if (reopeningSale) {
    // done_at stays: every reader pairs it with status = 'Done', and a
    // corrected sale belongs to the period it was made in, which may
    // already be reported. Sign-offs stay too: they approved the order as
    // it stood, and an edit while it is reopened asks for them again.
    await tx`
      UPDATE sell_orders
         SET status = 'Awaiting payment',
             notes = ${withReopenLine()},
             updated_at = NOW()
       WHERE id = ${id}
    `;
  } else {
    // done_at is the date the sale belongs to (dashboard, contributions),
    // stamped the first time the order becomes Done.
    await tx`
      UPDATE sell_orders
         SET status = ${body.to}, updated_at = NOW(),
             done_at = CASE WHEN ${body.to} = 'Done' THEN COALESCE(done_at, NOW()) ELSE done_at END
       WHERE id = ${id}
    `;
  }

  // Evidence persistence (status_meta upsert). Fires for any transition
  // INTO a meta-tracked status (Shipped / Awaiting payment / Done / Closed).
  // Draft is intentionally excluded: reopen-to-Draft notes live in
  // sell_order_events so successive reopen cycles don't overwrite each
  // other (status_meta PK is sell_order_id + status, single row per pair).
  // A reopened sale is excluded for the same reason: the evidence it took
  // into Awaiting payment stays, and the reopen note lives in its event.
  if (META_STATUSES.has(body.to) && !reopeningSale) {
    await tx`
      INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_at, set_by)
      VALUES (${id}, ${body.to}, ${body.note ?? null}, NOW(), ${actorId})
      ON CONFLICT (sell_order_id, status) DO UPDATE SET
        note   = EXCLUDED.note,
        set_at = NOW(),
        set_by = EXCLUDED.set_by
    `;
  }

  // The reverse of Done's consumption below, at the qty and status worked
  // out per lot above. qty_purchased already holds what was bought, so it
  // is left alone.
  let withdrawn: WithdrawnPrice[] = [];
  if (reopeningSale) {
    const goodsFollowsLines = await soldSourceGoodsVerdicts(tx, id);
    await tx`
      WITH back AS (
        UPDATE order_lines ol
           SET qty = r.qty, status = r.status
          FROM unnest(${restored.map(r => r.id)}::uuid[], ${restored.map(r => r.status)}::text[],
                      ${restored.map(r => r.qty)}::int[], ${restored.map(r => r.back)}::int[])
               AS r(id, status, qty, back)
         WHERE ol.id = r.id
        RETURNING ol.id AS line_id, ol.qty AS remaining, r.back AS returned
      )
      INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
      SELECT b.line_id, ${actorId}::uuid, 'unsold',
             jsonb_build_object('returnedQty', b.returned, 'remainingQty', b.remaining,
                                'sellOrder', ${id}::text)
      FROM back b
    `;
    for (const [orderId, isMirror] of goodsFollowsLines) {
      await syncOrderGoodsTotal(tx, orderId, isMirror);
    }
    withdrawn = await retractSaleDataPoints(tx, id);
  }

  // Audit-event writes for close + reopen. Done's audit story is the
  // inventory_events rows below; archive lives in its own handler.
  if (body.to === 'Closed') {
    const withdrawnBids = await retractBidDataPoints(tx, id);
    await writeSellOrderEvent(tx, id, actorId, 'closed', {
      reasonId: body.closeReasonId!,
      note: body.note ?? null,
      fromStatus: cur.status,
      ...(withdrawnBids.length ? { withdrawnPrices: withdrawnBids } : {}),
    });
  } else if (reopening || reopeningSale) {
    // The withdrawn market prices are named here, the one record left of
    // them once their events are gone.
    await writeSellOrderEvent(tx, id, actorId, 'reopened', {
      note: body.note ?? null,
      fromStatus: cur.status,
      ...(reopeningSale ? { withdrawnPrices: withdrawn } : {}),
    });
  } else {
    await writeSellOrderEvent(tx, id, actorId, 'status_changed', {
      from: cur.status,
      to: body.to,
    });
  }

  if (body.to === 'Done') {
    // Done consumes stock. A sold-out line doesn't drop to 0 — a 0-qty
    // line means none of it arrived — instead it flips to status 'Sold'.
    // In-stock aggregates key off status, so a Sold line falls out
    // regardless of its retained qty. Partially-sold lines lose qty and
    // stay sellable. Aggregated by inventory_id so multiple lines hitting
    // the same source net out.
    //
    // Lines held at 0 sold nothing: they move no stock and owe no commission.
    const goodsFollowsLines = await soldSourceGoodsVerdicts(tx, id);

    // The decrement and its audit rows are one statement: `sold` feeds the
    // inserts directly, with the same detail keys each row used to be
    // written with one at a time. `pre` reads the statement's snapshot, so
    // it holds each lot as it was before the decrement: a reopen restores
    // a sold-out lot's status from it, and never gives back more than the
    // lot had.
    await tx`
      WITH pre AS (
        SELECT id, status, qty FROM order_lines
        WHERE id IN (SELECT inventory_id FROM sell_order_lines
                      WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL AND qty > 0)
      ),
      sold AS (
        UPDATE order_lines ol
           SET qty    = CASE WHEN ol.qty - s.q <= 0 THEN ol.qty ELSE ol.qty - s.q END,
               status = CASE WHEN ol.qty - s.q <= 0 THEN 'Sold' ELSE ol.status END,
               -- A partial sale is the moment qty stops meaning "how many were
               -- bought", so the PO's goods total needs that number kept here
               -- before the decrement below overwrites it. Selling a line out
               -- leaves qty alone, so it still speaks for both.
               qty_purchased = CASE WHEN ol.qty - s.q <= 0 THEN ol.qty_purchased
                                    ELSE COALESCE(ol.qty_purchased, ol.qty) END
          FROM (
            SELECT inventory_id, SUM(qty)::int AS q
            FROM sell_order_lines
            WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL AND qty > 0
            GROUP BY inventory_id
          ) s
         WHERE s.inventory_id = ol.id
        RETURNING ol.id AS line_id,
                  CASE WHEN ol.status = 'Sold' THEN 0 ELSE ol.qty END AS remaining,
                  s.q AS sold
      )
      INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
      SELECT r.line_id, ${actorId}::uuid, 'sold',
             jsonb_build_object('soldQty', r.sold, 'remainingQty', r.remaining,
                                'sellOrder', ${id}::text,
                                'priorStatus', p.status, 'priorQty', p.qty)
      FROM sold r JOIN pre p ON p.id = r.line_id
    `;
    for (const [orderId, isMirror] of goodsFollowsLines) {
      await syncOrderGoodsTotal(tx, orderId, isMirror);
    }
    const submitters = await tx<{ user_id: string }[]>`
      SELECT DISTINCT o.user_id
      FROM sell_order_lines sol
      JOIN order_lines l ON l.id = sol.inventory_id
      JOIN orders o ON o.id = l.order_id
      WHERE sol.sell_order_id = ${id} AND sol.inventory_id IS NOT NULL AND sol.qty > 0
    `;
    for (const s of submitters) {
      await notify(tx, {
        userId: s.user_id,
        kind: 'payment_received',
        tone: 'pos',
        icon: 'cash',
        title: `Sell order ${id} closed`,
        body: 'Commission ready for review.',
      });
    }

    // A completed sale is the most authoritative price signal we have —
    // record one market data point per sold product.
    await retractUnpricedBids(tx, id);
    await recordSaleDataPoints(tx, id, actorId);
  }
  return { kind: 'done' };
}
