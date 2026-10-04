// A PO's moves through its life: revert acknowledgement, delete, archive,
// the lot-price reset, advance and hand-off.
import { Hono, type Context } from 'hono';
import { getDb } from '../../db';
import { deleteAttachments } from '../../r2';
import { diff, writeOrderEvent, wasEverSubmitted } from '../../services/orderAudit';
import { effectiveRole } from '../../lib/role';
import { advanceOrderTx, archiveOrderLinesTx, unarchiveOrderLinesTx, LIFECYCLE_LABEL, visibleLifecycle, type ArchiveSellOrderConflict } from '../../services/orderAdvance';
import { companyPayTxnUnknown } from '../../services/orderTxnRule';
import { handoffOrderTx, HandoffRefused, type HandoffInput } from '../../services/orderHandoff';
import { pickBankProviders } from '../../banktx';
import { reportSyncResult, syncBankTransactions } from '../../banktx/sync';
import { createRateLimiter } from '../../lib/rate-limit';
import { syncOrderGoodsTotal } from '../../services/orderGoodsTotal';
import { normalizeTracking, type Carrier, type PackageSource } from '@recycle-erp/shared';
import { type Env, type User } from '../../types';
import { PAYPAL_TXN_STRICT, normPaypalTxnId } from '../../ai/paypal';
import { log } from '../../lib/log';
import { type OrdersEnv, committedLinesBody, describeSellOrders, handoffByErr, isOrderPayment, isPaymentMethod, PACKAGE_DELIVERED_MSG, parseCommissionRate, registerIfNeeded, resolveOrderOwner, sourceErr, TRACKING_TAKEN_STANDALONE_MSG, trackingErr, trackingTakenMsg, unackedRevertFrag, warehouseErr } from './shared';

const lifecycleRoutes = new Hono<OrdersEnv>();

// ── Mark the purchaser's post-submission changes as reviewed. One manager
// acknowledging clears the dialog for all of them: the point is that somebody
// looked, not that everybody did. A later edit writes a newer `reverted` event
// and arms it again.
lifecycleRoutes.post('/:id/revert-ack', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  // A write: the raw role, so a manager previewing as a purchaser can still
  // clear the dialog (lib/role.ts).
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const order = (await sql`SELECT id FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!order) return c.json({ error: 'Not found' }, 404);

  const acknowledged = await sql.begin(async (tx) => {
    const pending = await tx<{ id: string }[]>`
      SELECT e.id FROM order_events e
      WHERE e.order_id = ${id} AND e.kind = 'reverted'
        AND ${unackedRevertFrag(tx, id)}
    `;
    // Nothing pending: acking anyway would leave a row saying a manager
    // reviewed changes that were already reviewed.
    if (pending.length > 0) {
      await writeOrderEvent(tx, id, u.id, 'revert_ack', {
        acknowledged: pending.length,
        ackedIds: pending.map(r => r.id),
      });
    }
    return pending.length;
  });

  return c.json({ ok: true, acknowledged });
});


// ── Delete a Draft order. Guarded: only the owner/manager, only while still
// a Draft, and never if a line has already been sold.
lifecycleRoutes.delete('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  // Guards + DELETE run in one tx with the orders row locked FOR UPDATE so a
  // concurrent advance can't move the order out of Draft (or a sell-order
  // attach a line) between the check and the delete.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'forbidden' }
    | { kind: 'notDraft' }
    | { kind: 'wasSubmitted' }
    | { kind: 'sold' }
    | { kind: 'ok'; scanned: { k: string }[] };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { user_id: string; lifecycle: string } | undefined;
    if (!existing) return { kind: 'notFound' };
    if (u.role !== 'manager' && existing.user_id !== u.id) return { kind: 'forbidden' };
    if (existing.lifecycle !== 'draft') return { kind: 'notDraft' };
    // A purchaser edit puts a submitted order back in Draft, which would
    // otherwise re-open this door: delete follows the order's history, not its
    // current stage, so once it has left Draft it can only be archived.
    // `reverted` counts on its own — an order can only be reverted from a
    // later stage, and rows seeded past Draft have no `submitted` event.
    if (await wasEverSubmitted(tx, id)) return { kind: 'wasSubmitted' };

    const sold = (await tx`
      SELECT 1 FROM sell_order_lines sol
      JOIN order_lines ol ON ol.id = sol.inventory_id
      WHERE ol.order_id = ${id} LIMIT 1
    `)[0];
    if (sold) return { kind: 'sold' };

    // Both R2 sources for this order: label scans and explicit line photos.
    const scanned = await tx`
      SELECT scan_image_id AS k FROM order_lines
      WHERE order_id = ${id} AND scan_image_id IS NOT NULL
      UNION ALL
      SELECT storage_key AS k FROM order_line_photos WHERE order_id = ${id}
    ` as { k: string }[];

    // The FK's SET NULL clears only order_id and trips the paired link CHECKs,
    // so a draft that ever had a payment linked could never be deleted. No
    // no_auto_link tombstone: the payment is free to find the PO it paid for.
    await tx`
      UPDATE bank_transactions
         SET order_id = NULL, link_kind = NULL, link_auto = FALSE,
             linked_by = NULL, linked_at = NULL
       WHERE order_id = ${id}
    `;
    await tx`DELETE FROM orders WHERE id = ${id}`; // order_lines cascade via FK
    return { kind: 'ok', scanned };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (outcome.kind === 'notDraft') return c.json({ error: 'Only Draft orders can be deleted' }, 403);
  if (outcome.kind === 'wasSubmitted') {
    return c.json({ error: 'This order has already been submitted — archive it instead' }, 403);
  }
  if (outcome.kind === 'sold') {
    return c.json({ error: 'A line in this order is referenced by a sell-order and cannot be deleted' }, 409);
  }

  // Best-effort: drop the images from R2 too (after the commit). One PO can
  // carry a scan plus six photos per line, so this is batched rather than a
  // round trip each.
  const orphaned = await deleteAttachments(c.env, outcome.scanned.map(r => r.k));
  if (orphaned.length) log.error('r2 delete (order deleted)', orphaned);

  return c.json({ ok: true });
});

// ── Archive / unarchive a Purchase Order.
//
// Archive hides the order from the default list (orders.archived_at) and takes
// its goods out of stock (services/orderAdvance.ts, archiveOrderLinesTx),
// available to the owner or any manager once the order has left Draft. Hard
// delete stays Draft-only — once business records exist we want them around
// for audit, sell-order references, and commission history.
//
// Both endpoints lock the orders row FOR NO KEY UPDATE inside a single tx so a
// concurrent archive + unarchive can't race, and so the audit event is only
// committed if the flag flip succeeds.
type OrderCtx = Context<{ Bindings: Env; Variables: { user: User } }>;

async function setArchived(c: OrderCtx, archive: boolean) {
  const u = c.var.user;
  // Route is mounted with `:id`, so Hono populates this — assert for the type.
  const id = c.req.param('id') as string;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as { removeFromSellOrders?: boolean } | null;
  // Pulling lines off sell orders — and seeing which sell orders those are —
  // is manager work: every /api/sell-orders route 403s a purchaser, and the
  // conflict payload would hand the same ids, statuses and lines to a PO
  // owner. A purchaser gets a plain refusal and no lever.
  const isManager = u.role === 'manager';
  const removeFromSellOrders = isManager && body?.removeFromSellOrders === true;

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'forbidden' }
    | { kind: 'isDraft' }
    | { kind: 'noChange' }
    | { kind: 'committedLines'; sellOrders: ArchiveSellOrderConflict[] }
    | { kind: 'transferClaimed'; offendingLineIds: string[] }
    | { kind: 'ok' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT user_id, lifecycle, archived_at FROM orders WHERE id = ${id} LIMIT 1 FOR NO KEY UPDATE
    `)[0] as { user_id: string; lifecycle: string; archived_at: string | null } | undefined;
    if (!existing) return { kind: 'notFound' };
    if (!isManager && existing.user_id !== u.id) return { kind: 'forbidden' };
    // Draft orders use Delete, not Archive — Archive only applies once an
    // order is part of the business record. A reverted order is a Draft that
    // HAS been submitted, and Delete refuses exactly those, so the history has
    // to decide here too or the order can be neither deleted nor archived.
    // Unarchiving is never blocked: whatever got archived can always go back.
    if (archive && existing.lifecycle === 'draft' && !(await wasEverSubmitted(tx, id))) {
      return { kind: 'isDraft' };
    }
    const wasArchived = existing.archived_at !== null;
    if (wasArchived === archive) return { kind: 'noChange' };

    const actor = { id: u.id, name: u.name, role: u.role };
    if (archive) {
      const lines = await archiveOrderLinesTx(tx, id, actor, { removeFromSellOrders });
      if (lines.kind !== 'ok') return lines;
      await tx`UPDATE orders SET archived_at = NOW() WHERE id = ${id}`;
      await writeOrderEvent(tx, id, u.id, 'archived', {
        lines: lines.lines, removedSellOrderLines: lines.removedSellOrderLines,
      });
    } else {
      const lines = await unarchiveOrderLinesTx(tx, id, actor);
      await tx`UPDATE orders SET archived_at = NULL WHERE id = ${id}`;
      await writeOrderEvent(tx, id, u.id, 'unarchived', { lines: lines.lines });
    }
    return { kind: 'ok' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (outcome.kind === 'isDraft') return c.json({ error: 'Draft orders cannot be archived — delete instead' }, 403);
  if (outcome.kind === 'noChange') {
    return c.json({ error: archive ? 'Order is already archived' : 'Order is not archived' }, 409);
  }
  // `code` is what the client keys the confirm dialog on: "already archived"
  // above is a 409 too.
  if (outcome.kind === 'committedLines') {
    if (!isManager) {
      return c.json({ error: 'Lines in this order are on open sell orders — a manager has to archive it.' }, 409);
    }
    return c.json({
      error: 'Lines in this order are on open sell orders. Remove them from those sell orders to archive it.',
      code: 'committedLines',
      sellOrders: outcome.sellOrders,
    }, 409);
  }
  if (outcome.kind === 'transferClaimed') {
    return c.json({
      error: 'Lines are out on an open transfer order — receive or discard that transfer first.',
      offendingLineIds: outcome.offendingLineIds,
    }, 409);
  }
  return c.json({ ok: true });
}

// A total_cost that no longer matches the lines is a negotiated lot price, and
// it survives every line edit after it (services/orderGoodsTotal.ts). Nothing
// in the editors can tell "we agreed $8,500 for the lot" from "that number
// went stale", so a manager says which: this lets go of the pinned figure and
// the total follows the lines again. A correction, so allowed at any stage.
lifecycleRoutes.post('/:id/total-cost/follow-lines', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const totalCost = await sql.begin(async (tx) => {
    const [before] = await tx<{ total_cost: number | null }[]>`
      SELECT total_cost::float AS total_cost FROM orders WHERE id = ${id} LIMIT 1 FOR NO KEY UPDATE
    `;
    if (!before) return undefined;
    await syncOrderGoodsTotal(tx, id, true);
    const [after] = await tx<{ total_cost: number | null }[]>`
      SELECT total_cost::float AS total_cost FROM orders WHERE id = ${id} LIMIT 1
    `;
    const changes = diff(before, after, ['total_cost']);
    if (changes.length) await writeOrderEvent(tx, id, u.id, 'meta_changed', { changes });
    return after!.total_cost;
  });
  if (totalCost === undefined) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, totalCost });
});

lifecycleRoutes.post('/:id/archive',   c => setArchived(c, true));
lifecycleRoutes.post('/:id/unarchive', c => setArchived(c, false));

// The transaction-id rule's second half — the id must be a payment our
// PayPal account made — is judged inside the advance tx against the synced
// rows. A miss there may just be the six-hourly sync running behind PayPal,
// and purchasers cannot press Sync-now (the Payments page is a manager's), so
// an unknown id pulls PayPal once *before* the tx. The tx guard stays the
// verdict; this only makes sure it reads a fresh table. Two things to know:
// the sync is single-flighted per process, so a miss during the six-hourly
// run joins that run — which may have queried PayPal before the payment
// landed, in which case the guard refuses and the next attempt pulls again;
// and a miss costs one Transaction Search plus the dispute list, so each
// user gets a few pulls a minute and past that the guard reads the table as
// it stands — its refusal already says to try again later, and a purchaser
// retrying Submit should see the rule, not a rate-limit error. PayPal itself
// reports a payment up to three hours late, which no pull can shorten. Only
// an id in PayPal's own 17-character shape is worth the trip: a placeholder
// (`CASH`, `WAIT`) can never match, so the guard's refusal stands without
// asking PayPal, and a real id in some other shape waits for the scheduled
// sync.
//
// Returns the provider's error when the pull itself failed. The guard will
// refuse just the same — the table never got the row — but "check the ID" is
// the wrong thing to tell someone whose id was never looked up, so the
// refusal names the outage instead. The pass is reported like the loop's, or
// an expired key looks like a run of typos.
const pullRateLimited = createRateLimiter(60_000, 3);

async function pullPaypalIfUnknown(
  env: Env,
  sql: ReturnType<typeof getDb>,
  userId: string,
  order: Parameters<typeof companyPayTxnUnknown>[1],
): Promise<string | null> {
  const paypal = pickBankProviders(env).providers.find((p) => p.source === 'paypal');
  if (!paypal) return null;
  if (!PAYPAL_TXN_STRICT.test((order.paypal_txn_id ?? '').trim())) return null;
  if (!await companyPayTxnUnknown(sql, order)) return null;
  if (pullRateLimited(userId) !== null) return null;
  // The purchaser is waiting on Submit, and disputes answer nothing it asked.
  const result = await syncBankTransactions(env, [paypal], { disputes: false });
  reportSyncResult(result);
  return result.perSource.paypal?.error ?? null;
}

type TxnRuleRow = {
  payment: string; payment_method: string | null; paypal_txn_id: string | null; created_at: Date;
};

lifecycleRoutes.post('/:id/advance', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    { toStage?: string; fromStage?: unknown; enforce?: unknown; takeManager?: unknown;
      fromManagerId?: unknown } | null;

  // Only a live Draft meets the guard, so only one is worth a pull — the tx
  // refuses an archived order before it reads the id.
  const [rule] = await sql<(TxnRuleRow & { lifecycle: string; archived_at: Date | null })[]>`
    SELECT lifecycle, archived_at, payment, payment_method, paypal_txn_id, created_at
    FROM orders WHERE id = ${id}`;
  const pullError = rule?.lifecycle === 'draft' && !rule.archived_at
    ? await pullPaypalIfUnknown(c.env, sql, u.id, rule)
    : null;

  // The lifecycle read, all stage guards and the writes run inside one tx
  // with the orders row locked (FOR NO KEY UPDATE, which a delete's FOR
  // UPDATE still waits on — see services/orderAdvance.ts). Reading lifecycle outside the tx
  // let a concurrent delete (which also guarded on a stale lifecycle read)
  // delete an order that was being advanced, and vice-versa.
  //
  // `enforce` can only make the guard stricter: a caller that collects none
  // of the hand-off's facts asks for them to be there already.
  const outcome = await sql.begin(async (tx) =>
    advanceOrderTx(tx, id, { id: u.id, name: u.name, role: u.role }, body?.toStage, {
      enforce: body?.enforce === 'all' ? 'all' : 'rules',
      fromStage: typeof body?.fromStage === 'string' ? body.fromStage : undefined,
      takeManager: body?.takeManager === true,
      // null is an answer ("I saw none"); absent asks for no check.
      fromManagerId: typeof body?.fromManagerId === 'string' || body?.fromManagerId === null
        ? body.fromManagerId : undefined,
    }));

  if (outcome.kind !== 'ok') return advanceRefusedResponse(c, outcome, pullError);
  return c.json({ ok: true, lifecycle: outcome.nextStageId });
});

// One response per refusal, shared by /advance and /handoff so a rule reads
// the same whichever door the order came through.
function advanceRefusedResponse(
  c: OrderCtx,
  outcome: Exclude<Awaited<ReturnType<typeof advanceOrderTx>>, { kind: 'ok' }>,
  pullError: string | null = null,
) {
  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'forbidden': return c.json({ error: outcome.msg }, 403);
    case 'badStage': return c.json({ error: outcome.msg }, 400);
    case 'archived': return c.json({ error: 'Order is archived — unarchive it first' }, 409);
    case 'finalStage': return c.json({ error: 'Already at the final stage' }, 409);
    case 'soldIsAutomatic':
      return c.json({ error: 'Sold is not a stage you can choose — an order becomes Sold on its own once it is Done and every line has sold.' }, 409);
    case 'alreadySold':
      return c.json({ error: 'This order is Done and every line has sold. To reopen it, move it back to Reviewing or Ready to Pay.' }, 409);
    case 'sameStage':
      return c.json({
        error: `Order is already ${LIFECYCLE_LABEL[outcome.lifecycle] ?? outcome.lifecycle} — reload to see where it stands.`,
        lifecycle: outcome.lifecycle,
      }, 409);
    case 'stageMoved': {
      // Any role may name a `fromStage`; a purchaser still never learns Sold.
      const seen = visibleLifecycle(outcome.lifecycle, effectiveRole(c.var.user));
      return c.json({
        error: `Order is now ${LIFECYCLE_LABEL[seen] ?? seen} — reload to see where it stands.`,
        code: 'stageMoved',
        lifecycle: seen,
      }, 409);
    }
    case 'managerChanged':
      return c.json({
        error: outcome.manager
          ? `${outcome.manager.name} is now the manager of this order — reload to see it.`
          : 'This order no longer has a manager — reload to see it.',
        code: 'managerChanged',
        manager: outcome.manager,
      }, 409);
    case 'committedLines':
      return c.json(committedLinesBody(c.var.user, outcome.offendingLineIds, outcome.sellOrderIds,
        `Lines committed to ${describeSellOrders(outcome.sellOrderIds)} — cancel those sell orders first.`,
        'Lines in this order are on open sell orders — a manager has to move it.'), 409);
    case 'transferClaimed':
      return c.json({
        error: 'Lines are out on an open transfer order — receive or discard that transfer first.',
        offendingLineIds: outcome.offendingLineIds,
      }, 409);
    case 'missingTxnId':
      return c.json({
        error: 'This PO was paid by the company — add the payment transaction ID before submitting it.',
      }, 409);
    case 'unknownTxnId':
      if (pullError !== null) {
        return c.json({
          error: `Couldn't reach PayPal to check transaction ${outcome.paypalTxnId} — try again in a minute.`,
          paypalTxnId: outcome.paypalTxnId,
          pullFailed: true,
        }, 409);
      }
      return c.json({
        error: `PayPal transaction ${outcome.paypalTxnId} isn't in our PayPal account — check the ID. `
          + 'PayPal reports a new payment up to 3 hours late; if it was just sent, try again later.',
        paypalTxnId: outcome.paypalTxnId,
      }, 409);
    case 'missingChatShot':
      return c.json({
        error: 'This order was self-paid — attach the chat history with the seller before submitting it.',
      }, 409);
    case 'missingCashShot':
      return c.json({
        error: 'This order was paid in cash — attach a screenshot showing the total amount paid before submitting it.',
      }, 409);
    case 'noCost':
      return c.json({
        error: 'This PO has no cost — enter the unit cost on its lines before submitting it.',
      }, 409);
    case 'missingWarehouse':
      return c.json({ error: 'Pick the receiving warehouse before submitting it.' }, 409);
    case 'missingSource':
      return c.json({ error: 'Say where this order came from before submitting it.' }, 409);
    case 'missingDelivery':
      return c.json({
        error: 'Say how the goods get here — a shipping label, or who is collecting them — before submitting it.',
      }, 409);
    case 'missingTracking':
      return c.json({ error: 'Add the tracking number from the shipping label before submitting it.' }, 409);
    case 'missingMethod':
      return c.json({ error: 'Say how the company paid — PayPal or cash — before submitting it.' }, 409);
    // Hono lets a handler return nothing, so without this a new outcome kind
    // would fall out of the switch as an implicit undefined and a 200.
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// The Draft → In Transit hand-off: the dialog's answers, the package a pasted
// tracking number becomes, and the advance, in one transaction
// (services/orderHandoff.ts). Validation runs here on the pool first, like
// PATCH, so a bad body never opens the lock.
lifecycleRoutes.post('/:id/handoff', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as {
    warehouseId?: unknown; source?: unknown;
    handoff?: { method?: unknown; byUserId?: unknown; trackingNumber?: unknown; carrier?: unknown } | null;
    payment?: unknown; paymentMethod?: unknown;
    paypalTxnId?: unknown; paymentScreenshotKey?: unknown; paymentScreenshotUrl?: unknown;
    onBehalfOfUserId?: unknown; commissionRate?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  // Every field is optional — the checkpoint sends what the page lacks and
  // the transaction fills the rest from the row. Present-but-invalid is
  // still a 400; only absence means "keep what the order holds".
  if (body.warehouseId !== undefined) {
    if (typeof body.warehouseId !== 'string' || !body.warehouseId) {
      return c.json({ error: 'warehouseId is required' }, 400);
    }
    const whErr = await warehouseErr(sql, body.warehouseId);
    if (whErr) return c.json({ error: whErr }, 400);
  }
  if (body.source !== undefined) {
    const err = sourceErr(body.source);
    if (err || body.source === null) return c.json({ error: err ?? 'source must be facebook, local, reddit, or other' }, 400);
  }
  if (!isOrderPayment(body.payment)) return c.json({ error: 'payment must be company or self' }, 400);
  // A self-paid order has no method: it is reimbursed from commission. The
  // company card names one, and cash is what lifts the transaction-id rule.
  // Absent means the row's; the advance refuses a company row with none.
  let paymentMethod: 'paypal' | 'cash' | null | undefined;
  if (body.paymentMethod !== undefined) {
    if (!isPaymentMethod(body.paymentMethod)) {
      return c.json({ error: 'paymentMethod must be paypal or cash' }, 400);
    }
    paymentMethod = body.paymentMethod;
  }
  if (body.payment === 'self') paymentMethod = null;
  let paypalTxnId: string | null | undefined;
  if (body.paypalTxnId !== undefined) {
    paypalTxnId = normPaypalTxnId(body.paypalTxnId);
    if (paypalTxnId && paypalTxnId.length > 64) {
      return c.json({ error: 'PayPal transaction ID is too long' }, 400);
    }
  }
  const opt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const h = body.handoff;
  let handoff: HandoffInput['handoff'];
  if (h === undefined || h === null) {
    handoff = undefined;
  } else if (h.method === 'pickup') {
    if (h.byUserId !== undefined) {
      const by = await handoffByErr(sql, h.byUserId);
      if ('error' in by) return c.json({ error: by.error }, 400);
      handoff = { method: 'pickup', byUserId: by.member.id };
    } else {
      handoff = { method: 'pickup' };
    }
  } else if (h.method === 'label') {
    if (h.trackingNumber !== undefined || h.carrier !== undefined) {
      const tn = typeof h.trackingNumber === 'string' ? normalizeTracking(h.trackingNumber) : '';
      const err = trackingErr(tn, h.carrier);
      if (err) return c.json({ error: err }, 400);
      handoff = { method: 'label', trackingNumber: tn, carrier: h.carrier as Carrier };
    } else {
      handoff = { method: 'label' };
    }
  } else {
    return c.json({ error: 'handoff.method must be pickup or label' }, 400);
  }

  if (body.commissionRate !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can set the commission rate' }, 403);
  }
  const rate = parseCommissionRate(body.commissionRate);
  if ('error' in rate) return c.json({ error: rate.error }, 400);
  const commissionRate = rate.rate;
  if (body.onBehalfOfUserId !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can change the order owner' }, 403);
  }
  let newOwner: HandoffInput['newOwner'];
  if (body.onBehalfOfUserId !== undefined) {
    const resolved = await resolveOrderOwner(sql, u, body.onBehalfOfUserId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    newOwner = resolved;
  }

  const input: HandoffInput = {
    warehouseId: body.warehouseId as string | undefined,
    source: body.source as PackageSource | undefined,
    handoff,
    payment: body.payment,
    paymentMethod,
    paypalTxnId,
    paymentScreenshotKey: opt(body.paymentScreenshotKey),
    paymentScreenshotUrl: opt(body.paymentScreenshotUrl),
    newOwner,
    commissionRate,
  };
  // What the hand-off is about to write is what the advance inside it judges,
  // so the pull reads the request merged over the row — an id saved earlier
  // from the page is pulled for just the same.
  const [rule] = await sql<TxnRuleRow[]>`
    SELECT payment, payment_method, paypal_txn_id, created_at FROM orders WHERE id = ${id}`;
  const merged = rule && {
    payment: input.payment ?? rule.payment,
    payment_method: paymentMethod !== undefined ? paymentMethod : rule.payment_method,
    paypal_txn_id: paypalTxnId !== undefined ? paypalTxnId : rule.paypal_txn_id,
    created_at: rule.created_at,
  };
  const pullError = merged ? await pullPaypalIfUnknown(c.env, sql, u.id, merged) : null;

  let result: Awaited<ReturnType<typeof handoffOrderTx>>;
  try {
    result = await sql.begin(async (tx) =>
      handoffOrderTx(tx, id, { id: u.id, name: u.name, role: u.role }, input));
  } catch (e) {
    if (!(e instanceof HandoffRefused)) throw e;
    const r = e.refusal;
    switch (r.kind) {
      case 'notFound': return c.json({ error: 'Not found' }, 404);
      case 'forbidden': return c.json({ error: 'Forbidden' }, 403);
      case 'archived': return c.json({ error: 'Order is archived — unarchive it first' }, 409);
      case 'notDraft':
        return c.json({ error: `Order is already ${LIFECYCLE_LABEL[visibleLifecycle(r.lifecycle, effectiveRole(u))] ?? r.lifecycle}` }, 409);
      case 'trackingTaken':
        return c.json({ error: trackingTakenMsg(r.otherOrderId), otherOrderId: r.otherOrderId }, 409);
      case 'trackingTakenStandalone': return c.json({ error: TRACKING_TAKEN_STANDALONE_MSG }, 409);
      case 'packageDelivered': return c.json({ error: PACKAGE_DELIVERED_MSG }, 409);
      case 'advance': return advanceRefusedResponse(c, r.outcome, pullError);
      // Same guard as advanceRefusedResponse: a new kind must not fall out of
      // the switch as an implicit 200.
      default: {
        const exhaustive: never = r;
        return exhaustive;
      }
    }
  }
  registerIfNeeded(c.env, sql, result.package, result.needsRegister);
  return c.json({
    ok: true,
    lifecycle: 'in_transit',
    packageId: result.package?.id ?? null,
    ...(effectiveRole(u) === 'manager' ? { paymentsLinked: result.paymentsLinked } : {}),
  });
});

export default lifecycleRoutes;
