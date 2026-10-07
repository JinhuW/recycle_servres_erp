// PATCH /api/orders/:id — order fields and line edits in one transaction.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { deleteAttachments } from '../../r2';
import { UUID_RE } from '../../lib/pagination';
import { diff, writeOrderEvent, META_FIELDS, LINE_FIELDS, type AuditChange, type EventKind } from '../../services/orderAudit';
import { autoTrackParts } from '../../lib/marketAutoTrack';
import { effectiveRole } from '../../lib/role';
import { committedClaimsByLine, openSellStatuses } from '../../lib/sellCommitment';
import { specVal, validateLineInput } from '../../lib/orderInput';
import { revertOrderToDraftTx, LINE_STATUS_FOR_LIFECYCLE, isClosedBook } from '../../services/orderAdvance';
import { syncOrderCategory } from '../../services/orderCategory';
import { nameHandoffByChange, setOrderPackageTx, unlinkOrderPackagesTx, packageChanges, changeOrderOwnerTx, type HandoffPackage } from '../../services/orderHandoff';
import { linkPaypalTxnToOrder, unlinkPaypalTxnFromOrder } from '../../banktx/sync';
import { goodsTotalIsMirror, syncOrderGoodsTotal } from '../../services/orderGoodsTotal';
import { synthesizePartNumber, serialIssue, staleSpecDbCols, normSellPrice, normalizeTracking, isMaterialPatch, type Carrier, type PackageSource } from '@recycle-erp/shared';
import { normPaypalTxnId } from '../../ai/paypal';
import { log } from '../../lib/log';
import { type OrdersEnv, assertCategoriesEnabled, badFees, canonChipNumber, changesMaterialField, committedLinesBody, describeSellOrders, handoffByErr, handoffFactsAfter, identityErr, isOrderPayment, isPaymentMethod, lineAuditCols, type LineFields, type LinePatch, type LineSnapRow, lineSnapshot, newLineRow, normFeeNote, PACKAGE_DELIVERED_MSG, parseCommissionRate, registerIfNeeded, resolveOrderOwner, serialErr, sourceErr, type StoredLine, storedLineCols, supplierErr, TRACKING_TAKEN_STANDALONE_MSG, trackingErr, trackingTakenMsg, trackInput, warehouseErr } from './shared';
import { OrderRefusal, refusalResponse } from './refusal';

const patchRoutes = new Hono<OrdersEnv>();

// ── Edit — update order meta + line item details. The order owner
// (purchaser) or a manager may PATCH. Draft is purchaser-editable; later
// stages are manager-only apart from `notes` — enforced here, not just in the
// client, so a purchaser can't rewrite costs/lines on an order under review.
//
// Line shape on the wire:
//   lines:          updates for existing lines (each carries `id`)
//   addLines:       new line rows to INSERT (no `id`)
//   removeLineIds:  ids to DELETE (409 while an open, non-archived sell order
//                   names one)
patchRoutes.patch('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const body = (await c.req.json().catch(() => null)) as
    | {
        lines?: LinePatch[];
        addLines?: (LineFields & { category?: string })[];
        removeLineIds?: string[];
        totalCost?: number | null;
        supplierId?: string | null;
        otherFees?: number | null;
        otherFeesNote?: string | null;
        notes?: string | null;
        warehouseId?: string | null;
        payment?: 'company' | 'self';
        paymentMethod?: 'paypal' | 'cash' | null;
        commissionRate?: number | null;
        paypalTxnId?: string | null;
        onBehalfOfUserId?: string | null;
        source?: PackageSource | null;
        handoffMethod?: 'pickup' | 'label' | null;
        handoffBy?: string | null;
        trackingNumber?: string;
        carrier?: Carrier;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  // order_lines.id is uuid-typed: a malformed id reaches `::uuid[]` inside the
  // transaction and surfaces as a 500 instead of the 400 the client can act on.
  const isLineId = (v: unknown) => typeof v === 'string' && UUID_RE.test(v);
  if (body.lines != null
      && (!Array.isArray(body.lines) || !body.lines.every(l => isLineId((l as { id?: unknown } | null)?.id)))) {
    return c.json({ error: 'lines[].id must be a line id' }, 400);
  }
  if (body.removeLineIds != null
      && (!Array.isArray(body.removeLineIds) || !body.removeLineIds.every(isLineId))) {
    return c.json({ error: 'removeLineIds must be line ids' }, 400);
  }
  if (!isOrderPayment(body.payment)) return c.json({ error: 'payment must be company or self' }, 400);
  if (!isPaymentMethod(body.paymentMethod)) {
    return c.json({ error: 'paymentMethod must be paypal or cash' }, 400);
  }
  // The hand-off facts, now the page's to edit. Same validators as the
  // checkpoint; the collector is resolved here so the audit can name them.
  const srcErr = sourceErr(body.source);
  if (srcErr) return c.json({ error: srcErr }, 400);
  if (body.handoffMethod !== undefined && body.handoffMethod !== null
      && body.handoffMethod !== 'pickup' && body.handoffMethod !== 'label') {
    return c.json({ error: 'handoffMethod must be pickup or label' }, 400);
  }
  if (body.handoffBy !== undefined && body.handoffBy !== null) {
    const by = await handoffByErr(sql, body.handoffBy);
    if ('error' in by) return c.json({ error: by.error }, 400);
  }
  let tracking: { trackingNumber: string; carrier: Carrier } | undefined;
  if (body.trackingNumber !== undefined || body.carrier !== undefined) {
    const tn = typeof body.trackingNumber === 'string' ? normalizeTracking(body.trackingNumber) : '';
    const err = trackingErr(tn, body.carrier);
    if (err) return c.json({ error: err }, 400);
    tracking = { trackingNumber: tn, carrier: body.carrier as Carrier };
  }

  const existing = (await sql`SELECT user_id, category, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);
  // The purchaser owns their order until the review closes it (Ready to Pay):
  // goods arrive miscounted, fees land late, a line turns out to be something
  // else. What they may not do is change it under a manager who has already
  // reviewed it — so a change to anything the review is about sends the order
  // back to Draft (below, in the tx, where the lifecycle read is locked).
  // `notes` is not such a field: receipts and shipping details keep arriving
  // after the goods leave, and appending one leaves the order where it stands.
  // The one list the editors' revert warning reads too (@recycle-erp/shared).
  const materialEdit = isMaterialPatch(body as Record<string, unknown>) || tracking !== undefined;
  if (u.role !== 'manager' && existing.lifecycle !== 'draft') {
    // Past review the PO is a closed book to the purchaser, note included.
    if (isClosedBook(existing.lifecycle)) {
      return c.json({ error: 'Only managers can edit an order after submission' }, 403);
    }
    if (!materialEdit && body.notes === undefined && body.supplierId === undefined) {
      return c.json({ error: 'Only managers can edit an order after submission' }, 403);
    }
  }
  if (body.commissionRate !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can set the commission rate' }, 403);
  }
  // Owner reassignment: same manager-only rule as creating on behalf of
  // someone else, validated up front so a bad target fails before the tx.
  // `null` (or the manager's own id) hands the order back to the manager.
  if (body.onBehalfOfUserId !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can change the order owner' }, 403);
  }
  let newOwner: { ownerId: string; ownerName: string | null } | undefined;
  if (body.onBehalfOfUserId !== undefined) {
    const resolved = await resolveOrderOwner(sql, u, body.onBehalfOfUserId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    newOwner = resolved;
  }
  if (typeof body.paypalTxnId === 'string' && body.paypalTxnId.replace(/\s+/g, '').length > 64) {
    return c.json({ error: 'PayPal transaction ID is too long' }, 400);
  }
  const rate = parseCommissionRate(body.commissionRate);
  if ('error' in rate) return c.json({ error: rate.error }, 400);
  const clampedRate = rate.rate;

  const feeErr = badFees(body);
  if (feeErr) return c.json({ error: feeErr }, 400);

  // null clears the warehouse; a non-null value must exist (same boundary
  // check as the create endpoints — "" would 500 on the FK inside the tx).
  if (body.warehouseId !== undefined) {
    const whErr = await warehouseErr(sql, body.warehouseId ?? null);
    if (whErr) return c.json({ error: whErr }, 400);
  }
  if (body.supplierId !== undefined) {
    const supErr = await supplierErr(sql, u, body.supplierId ?? null);
    if (supErr) return c.json({ error: supErr }, 400);
  }

  // Field range gates — qty, unit_cost>=0, sell_price>=0. Without these,
  // a malformed value hits the order_lines CHECK constraint inside the tx
  // and surfaces as a 500. An existing line may be counted down to 0 (none of
  // it arrived); a new one needs at least 1.
  for (const l of body.lines ?? []) {
    const e = validateLineInput(l as Record<string, unknown>, 'patch', { allowZeroQty: true });
    if (e) return c.json({ error: e }, 400);
  }
  // A new line through PATCH has the INSERT's defaults (qty 1, cost 0) for
  // what it leaves out, so only what it carries is checked.
  for (const l of body.addLines ?? []) {
    const e = validateLineInput(l as Record<string, unknown>, 'patch');
    if (e) return c.json({ error: e }, 400);
  }

  // Serial rules. New rows are validated outright (defaults mirror the
  // INSERT below); existing-row patches only when the merged value (patch ??
  // stored — the same null-keeps-old semantics as the COALESCE in the UPDATE)
  // actually CHANGES serial/qty/generation. The edit forms echo every field
  // back on save, so a mere "touched" test would retro-block price/status
  // edits on legacy serial-less lines.

  // A new line may inherit the order's category, but orders.category is a
  // DERIVATION of the lines — it reads 'Mixed' when they disagree, and an empty
  // draft holds 'Mixed' as a placeholder. Neither is a category a line may
  // claim, so there is nothing to inherit and the request has to name one.
  const inheritedCat =
    existing.category && existing.category !== 'Mixed' ? (existing.category as string) : null;
  const addCats: string[] = [];
  for (let i = 0; i < (body.addLines ?? []).length; i++) {
    const l = body.addLines![i];
    const cat = l.category ?? inheritedCat;
    if (!cat) return c.json({ error: `line ${i + 1}: category is required` }, 400);
    addCats.push(cat);
    const issue = serialIssue({ ...l, category: cat, qty: l.qty ?? 1 });
    if (issue) return c.json({ error: serialErr(`line ${i + 1}`, issue) }, 400);
    const labelErr = identityErr(`line ${i + 1}`, cat, l);
    if (labelErr) return c.json({ error: labelErr }, 400);
  }

  // One pre-read covering both the item-type and the serial rules. Each is
  // evaluated against the line's OWN category merged with the patch — the
  // order's category is derived from its lines and says nothing about any
  // individual one.
  const patchIds = (body.lines ?? []).map(l => l.id);
  const storedById = new Map<string, StoredLine>();
  if (patchIds.length) {
    const rows = await sql`
      SELECT ${storedLineCols(sql)}
      FROM order_lines
      WHERE order_id = ${id} AND id = ANY(${patchIds}::uuid[])
    ` as StoredLine[];
    for (const r of rows) storedById.set(r.id, r);
  }

  // Categories this request actually PUTS a line into: every new line's
  // resolved category (a new line inheriting the order's must be checked too —
  // reading the raw field would let it be filed under a disabled one), and only
  // those existing lines whose category really moves. The edit forms echo
  // `category` back on every line, so testing the raw field instead would
  // retro-block a price edit on any PO holding a legacy line of a category
  // that has since been turned off.
  const touchedCats = [...addCats];

  for (const l of body.lines ?? []) {
    const row = storedById.get(l.id);
    if (!row) continue; // unknown ids no-op in the UPDATE below too
    const mergedCat = l.category ?? row.category ?? undefined;
    if (l.category !== undefined && l.category !== row.category) touchedCats.push(l.category);

    // Checked when the patch carries the item type, and when it moves the line
    // between categories — switching INTO Other without naming a type in the
    // same patch would otherwise land an unidentifiable line. Lines predating
    // item types hold NULL, so an untouched one is left alone.
    if (l.itemType !== undefined || l.category !== undefined) {
      const merged = l.itemType !== undefined ? l : { itemType: row.item_type };
      const labelErr = identityErr(`line ${l.id}`, mergedCat, merged);
      if (labelErr) return c.json({ error: labelErr }, 400);
    }

    // Generation belongs to RAM alone, so a line leaving RAM has it cleared —
    // evaluate the post-clear value, or switching a DDR5 line to SSD would
    // still demand serials for a generation the line no longer has.
    const clearing = l.category !== undefined && l.category !== row.category
      ? new Set(staleSpecDbCols(l.category))
      : new Set<string>();
    const merged = {
      generation: clearing.has('generation') ? null : (l.generation ?? row.generation),
      qty: l.qty ?? row.qty,
      serialNumber: l.serialNumber ?? row.serial_number,
    };
    const changes =
      l.category !== undefined && l.category !== row.category ||
      (merged.generation ?? null) !== (row.generation ?? null) ||
      Number(merged.qty) !== Number(row.qty) ||
      (merged.serialNumber ?? '') !== (row.serial_number ?? '');
    if (!changes) continue;
    const issue = serialIssue({ category: mergedCat ?? null, ...merged });
    if (issue) return c.json({ error: serialErr(`line ${l.id}`, issue) }, 400);
  }

  const patchCatErr = await assertCategoriesEnabled(sql, touchedCats);
  if (patchCatErr) return c.json({ error: patchCatErr }, 400);

  // R2 keys of label scans whose lines get removed — deleted after the tx
  // commits (R2 isn't transactional; never delete on a rolled-back change).
  const removedScanKeys: string[] = [];

  // Surfaced so the mobile autosave path can capture the new DB id of each
  // appended line; aligns 1:1 with the request's `addLines` ordering. Populated
  // inside the tx and only read after the tx commits.
  const addedLineIds: string[] = [];

  // Where the order ends up. Returned to the client so an edit that moved the
  // stage doesn't need a refetch to be shown correctly.
  let lifecycleAfter = existing.lifecycle as string;
  // The stage a purchaser edit pulled the order back from — set only when the
  // revert ran, and the flag the audit block writes its `reverted` event on.
  let revertedFrom: string | null = null;
  // Bank transactions a saved transaction id claimed. Returned so the client
  // can refresh the PO's payments ledger without a reload.
  let paymentsLinked = 0;
  // The linked box's move, audited with the fields; the row to register with
  // Shippo once the tx has committed.
  let packageChanged: AuditChange[] = [];
  let packageToRegister: HandoffPackage | null = null;

  try {
    await sql.begin(async (tx) => {
      // Lock the order + read fields we need for audit-diffing. The lock keeps
      // a concurrent advance from changing lifecycle between our pre/post
      // snapshots, so the diff describes one settled state transition.
      const orderBefore = (await tx`
        SELECT o.id, o.user_id, o.lifecycle, o.notes, o.warehouse_id, o.payment, o.payment_method,
               o.total_cost::float AS total_cost,
               o.commission_rate::float AS commission_rate,
               o.other_fees::float AS other_fees,
               o.other_fees_note,
               o.paypal_txn_id,
               o.supplier_id,
               o.archived_at,
               o.source, o.handoff_method, o.handoff_by,
               sup.name AS supplier_name,
               (SELECT json_build_object('trackingNumber', p.tracking_number, 'carrier', p.carrier)
                FROM packages p WHERE p.order_id = o.id
                ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS pkg
        FROM orders o
        LEFT JOIN suppliers sup ON sup.id = o.supplier_id
        WHERE o.id = ${id} LIMIT 1 FOR NO KEY UPDATE OF o
      `)[0] as
        | { id: string; user_id: string; lifecycle: string; notes: string | null;
            warehouse_id: string | null;
            payment: string; payment_method: string | null;
            total_cost: number | null; commission_rate: number | null;
            other_fees: number; other_fees_note: string | null; paypal_txn_id: string | null;
            supplier_id: string | null; archived_at: Date | null;
            source: string | null; handoff_method: string | null; handoff_by: string | null;
            supplier_name: string | null;
            pkg: { trackingNumber: string; carrier: string } | null }
        | undefined;
      if (!orderBefore) throw new Error('order disappeared mid-edit');
      // An archived order's lines sit at 'Archived'; a purchaser edit would
      // revert it to Draft and cascade them straight back into stock.
      if (orderBefore.archived_at) throw new OrderRefusal({ kind: 'archived' });
      lifecycleAfter = orderBefore.lifecycle;
      // From Ready to Pay on the PO is the closed-book record of what was
      // bought and what the purchaser is paid on. Any edit to lines, costs,
      // commission or ownership corrupts that record (and may also confuse
      // downstream sell-order / commission math). Re-open to Reviewing first
      // if the data really needs to change. Notes are the only field a
      // manager may freely append on a closed PO.
      if (isClosedBook(orderBefore.lifecycle)) {
        const touchesFrozen =
          (Array.isArray(body.lines) && body.lines.length > 0) ||
          (Array.isArray(body.addLines) && body.addLines.length > 0) ||
          (Array.isArray(body.removeLineIds) && body.removeLineIds.length > 0) ||
          body.totalCost !== undefined ||
          // The fee note is frozen alongside the amount: it is metadata on a
          // closed-book cost, not the free-append `notes` field.
          body.otherFees !== undefined ||
          body.otherFeesNote !== undefined ||
          body.commissionRate !== undefined ||
          // The payment reference is part of the closed book too — and so is
          // who paid: a flip to self moves the reimbursement into commission.
          // A re-save echoing the stored value changes nothing.
          body.paypalTxnId !== undefined ||
          body.paymentMethod !== undefined ||
          (body.payment !== undefined && body.payment !== orderBefore.payment) ||
          // Ownership decides whose closed book this is — commission and
          // "my orders" both key off it, so it freezes with the rest.
          body.onBehalfOfUserId !== undefined;
        if (touchesFrozen) {
          throw new OrderRefusal({ kind: 'doneLocked' });
        }
        // The pre-tx read may have seen an earlier stage: a concurrent advance
        // past review must close the book on the purchaser here too, not
        // revert it.
        if (u.role !== 'manager') throw new OrderRefusal({ kind: 'purchaserDone' });
      }

      // Read before anything moves: afterwards a goods total that merely went
      // stale is indistinguishable from one that was negotiated. Only asked
      // when this request will actually change the lines, and skipped when it
      // states a goods total outright — then the client's figure is the answer.
      const touchesLines = !!(body.lines || body.addLines || body.removeLineIds);
      // Only a positive figure is a negotiated lot price. POST reads it the
      // same way, and for the same reason: stored literally, a 0 pins the
      // column at $0 against real lines, and no screen sends a totalCost any
      // more to put it back. Anything else non-positive (or unparseable) is
      // read as "not stated" rather than written through.
      const statedGoods = Number(body.totalCost) > 0 ? Number(body.totalCost) : undefined;
      const goodsFollowsLines = (touchesLines || body.totalCost !== undefined) && statedGoods === undefined
        ? await goodsTotalIsMirror(tx, id)
        : false;

      // Snapshot the lines we'll edit / remove so we can diff after the writes.
      // The ids being removed ride along so the no-op check below can tell a
      // real removal from a replay naming rows that are already gone.
      const editIds = [
        ...(Array.isArray(body.lines) ? body.lines.map(l => l.id) : []),
        ...(Array.isArray(body.removeLineIds) ? body.removeLineIds : []),
      ];
      const linesBefore = editIds.length
        ? await tx`
            SELECT ${lineAuditCols(tx)}
            FROM order_lines WHERE order_id = ${id} AND id = ANY(${editIds}::uuid[])`
        : [];
      const beforeMap = new Map<string, Record<string, unknown>>(
        linesBefore.map(l => [l.id as string, l as Record<string, unknown>]));

      // Back to Draft before anything is written, so the lines this request
      // adds are inserted at the stage the order is landing in rather than the
      // one it is leaving. The snapshot above is a read, so it is safe to take
      // first — and it is what tells a real edit from a no-op re-save. The
      // guards inside run against the pre-edit lines, so the ids they report
      // are the ones the client can see.
      if (u.role !== 'manager' && orderBefore.lifecycle !== 'draft' && materialEdit
          && changesMaterialField(body, orderBefore as unknown as Record<string, unknown> & typeof orderBefore, beforeMap)) {
        const outcome = await revertOrderToDraftTx(tx, id, u, orderBefore.lifecycle);
        if (outcome.kind === 'committedLines') {
          throw new OrderRefusal({ kind: 'revertCommitted', lineIds: outcome.offendingLineIds });
        }
        if (outcome.kind === 'transferClaimed') {
          throw new OrderRefusal({ kind: 'revertTransfer', lineIds: outcome.offendingLineIds });
        }
        revertedFrom = outcome.from;
        lifecycleAfter = 'draft';
      }

      let removedSnapshots: LineSnapRow[] = [];

      const touchesOrder =
        body.totalCost !== undefined ||
        body.otherFees !== undefined ||
        body.otherFeesNote !== undefined ||
        body.notes !== undefined ||
        body.warehouseId !== undefined ||
        body.payment !== undefined ||
        body.paymentMethod !== undefined ||
        body.commissionRate !== undefined ||
        body.paypalTxnId !== undefined ||
        body.supplierId !== undefined ||
        body.source !== undefined ||
        body.handoffMethod !== undefined ||
        body.handoffBy !== undefined;
      // The collector follows the method the way payment_method follows
      // payment: NULL unless the after-state is pickup.
      const facts = handoffFactsAfter(body, orderBefore);
      if (touchesOrder) {
        // Nullable fields use a CASE WHEN sentinel so the client can clear
        // them by sending `null`; bare COALESCE would treat null as "no
        // change" and silently keep the old value. `payment` is a non-null
        // enum, so COALESCE is correct for it.
        const setTotalCost = statedGoods !== undefined ? 1 : 0;
        const setNotes     = body.notes       !== undefined ? 1 : 0;
        const setWarehouse = body.warehouseId !== undefined ? 1 : 0;
        const setCommission = body.commissionRate !== undefined ? 1 : 0;
        const setOtherFees = body.otherFees     !== undefined ? 1 : 0;
        const setFeesNote  = body.otherFeesNote !== undefined ? 1 : 0;
        // The id follows the method the way the method follows the payment:
        // a request that flips to Self or Cash clears it, sent or not. Only
        // the flip — a later notes-only save on a self-paid PO leaves alone
        // whatever create-po carried over from a scanned screenshot.
        const clearPaypal  = body.payment === 'self' || body.paymentMethod === 'cash';
        const setPaypal    = body.paypalTxnId   !== undefined || clearPaypal ? 1 : 0;
        const setSupplier  = body.supplierId    !== undefined ? 1 : 0;
        const setSource    = body.source        !== undefined ? 1 : 0;
        const setMethodHo  = body.handoffMethod !== undefined ? 1 : 0;
        const setBy        = body.handoffMethod !== undefined || body.handoffBy !== undefined ? 1 : 0;
        // A self-paid order has no method: flipping to self clears it whether
        // or not the request said so, and a method sent alongside is dropped.
        const paymentAfter = body.payment ?? orderBefore.payment;
        const setMethod    = paymentAfter === 'self' || body.paymentMethod !== undefined ? 1 : 0;
        const newMethod    = paymentAfter === 'self' ? null : (body.paymentMethod ?? null);
        // Same canon as the add-package boundary — a pasted id with spaces or
        // lowercase must diff clean against the AI-extracted value.
        const normPaypal = clearPaypal ? null : normPaypalTxnId(body.paypalTxnId);
        await tx`
          UPDATE orders SET
            total_cost   = CASE WHEN ${setTotalCost}::int = 1 THEN ${statedGoods ?? null}      ELSE total_cost   END,
            notes        = CASE WHEN ${setNotes}::int     = 1 THEN ${body.notes ?? null}       ELSE notes        END,
            warehouse_id = CASE WHEN ${setWarehouse}::int = 1 THEN ${body.warehouseId ?? null} ELSE warehouse_id END,
            commission_rate = CASE WHEN ${setCommission}::int = 1 THEN ${clampedRate ?? null} ELSE commission_rate END,
            paypal_txn_id = CASE WHEN ${setPaypal}::int = 1 THEN ${normPaypal} ELSE paypal_txn_id END,
            supplier_id  = CASE WHEN ${setSupplier}::int = 1 THEN ${body.supplierId ?? null} ELSE supplier_id END,
            -- other_fees is NOT NULL: a client clearing the field sends null and
            -- means 0, so the sentinel writes 0 rather than passing the null
            -- through into the constraint. The note is nullable and follows the
            -- same clear-with-null contract as notes/warehouse_id.
            other_fees      = CASE WHEN ${setOtherFees}::int = 1 THEN ${Number(body.otherFees ?? 0)}    ELSE other_fees      END,
            other_fees_note = CASE WHEN ${setFeesNote}::int  = 1 THEN ${normFeeNote(body.otherFeesNote)} ELSE other_fees_note END,
            payment      = COALESCE(${body.payment ?? null}, payment),
            payment_method = CASE WHEN ${setMethod}::int = 1 THEN ${newMethod} ELSE payment_method END,
            source         = CASE WHEN ${setSource}::int = 1 THEN ${body.source ?? null} ELSE source END,
            handoff_method = CASE WHEN ${setMethodHo}::int = 1 THEN ${facts.method} ELSE handoff_method END,
            handoff_by     = CASE WHEN ${setBy}::int = 1 THEN ${facts.by}::uuid ELSE handoff_by END
          WHERE id = ${id}
        `;
        // A corrected or cleared id must take its old payments with it, or the
        // ledger keeps reading this PO as paid by a payment it no longer names.
        const oldPaypal = normPaypalTxnId(orderBefore.paypal_txn_id);
        if (setPaypal && oldPaypal && oldPaypal !== normPaypal) {
          await unlinkPaypalTxnFromOrder(tx, id, oldPaypal);
        }
        // The id names a payment that has very likely already synced, so link
        // it here rather than leaving it to a pass that runs every six hours.
        // Not gated on the value having changed: only free transactions are
        // claimed, so re-saving is idempotent, and someone re-saving because
        // the payment still isn't showing should get the link.
        if (setPaypal && normPaypal) {
          paymentsLinked = await linkPaypalTxnToOrder(tx, normPaypal, id, u.id);
        }
      }
      // Owner moves under the same lock as the meta fields.
      if (newOwner && newOwner.ownerId !== orderBefore.user_id) {
        await changeOrderOwnerTx(tx, id, u, orderBefore.user_id, newOwner);
      }
      // The box, under the same lock as the fields that describe it. A
      // tracking number only makes sense on a label; a flip away from label
      // parts with the box (unlinked, not deleted — see the helper).
      if (tracking) {
        if (facts.method !== 'label') throw new OrderRefusal({ kind: 'trackingNeedsLabel' });
        const set = await setOrderPackageTx(tx, id, { id: u.id, role: u.role }, {
          user_id: orderBefore.user_id,
          source: body.source !== undefined ? body.source : orderBefore.source,
          supplier_name: orderBefore.supplier_name,
          paypal_txn_id: body.paypalTxnId !== undefined
            ? normPaypalTxnId(body.paypalTxnId)
            : orderBefore.paypal_txn_id,
        }, tracking);
        if (set.kind === 'taken') throw new OrderRefusal({ kind: 'trackingTaken', otherOrderId: set.otherOrderId });
        if (set.kind === 'takenStandalone') throw new OrderRefusal({ kind: 'trackingTakenStandalone' });
        if (set.kind === 'delivered') throw new OrderRefusal({ kind: 'packageDelivered' });
        packageChanged = packageChanges(set.prev, set.package);
        packageToRegister = set.needsRegister ? set.package : null;
      } else if (body.handoffMethod !== undefined && facts.method !== 'label'
                 && orderBefore.handoff_method === 'label') {
        const unlinked = await unlinkOrderPackagesTx(tx, id);
        if (unlinked.kind === 'delivered') throw new OrderRefusal({ kind: 'packageDelivered' });
        if (unlinked.gone.length) packageChanged = packageChanges(unlinked.gone[0], null);
      }
      if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        const doomed = await tx`
          SELECT id, category, scan_image_id, part_number, qty, unit_cost::float AS unit_cost FROM order_lines
          WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])
        ` as (LineSnapRow & { scan_image_id: string | null })[];
        removedSnapshots = doomed.map(r => ({ id: r.id, category: r.category, part_number: r.part_number, qty: r.qty, unit_cost: r.unit_cost }));
        // Read before the DELETE cascades the rows away. Same list as the scan
        // keys, so the existing post-commit sweep covers both.
        //
        // Keyed off `doomed`, NOT the raw removeLineIds: the request's ids are
        // unverified, and an id belonging to somebody else's PO would delete
        // that PO's objects out of R2 while its rows survived pointing at them.
        const doomedPhotos = doomed.length ? await tx`
          SELECT storage_key FROM order_line_photos
          WHERE order_line_id = ANY(${doomed.map(r => r.id)}::uuid[])
        ` as { storage_key: string }[] : [];
        for (const p of doomedPhotos) removedScanKeys.push(p.storage_key);

        // A sell order holds a line only while it is open — the shared
        // OPEN_SELL_STATUSES rule the archive dialog uses — and not archived.
        // Closed released the stock and Done consumed it: both keep their
        // snapshot and let the source line go (the FK is SET NULL since 0127).
        // An archived one releases too, and the only open status it can hold
        // is Draft: archiving a Shipped or Awaiting-payment order is refused,
        // and so is moving an archived one back into either — what is left is
        // a Closed order reopened to Draft, which reserves nothing. A line held
        // at 0 holds nothing either: it lets the lot go the same way and stays
        // on its order, with its #, as a typed line.
        const stillNamed = doomed.length ? await tx`
          SELECT DISTINCT sol.inventory_id AS line_id, sol.sell_order_id
          FROM sell_order_lines sol
          JOIN sell_orders so ON so.id = sol.sell_order_id
          WHERE sol.inventory_id = ANY(${doomed.map(r => r.id)}::uuid[])
            AND so.archived_at IS NULL
            AND so.status = ANY(${openSellStatuses()}::text[])
            AND sol.qty > 0
        ` as { line_id: string; sell_order_id: string }[] : [];
        if (stillNamed.length) {
          throw new OrderRefusal({
            kind: 'removeReferenced',
            lineIds: [...new Set(stillNamed.map(r => r.line_id))],
            sellOrderIds: [...new Set(stillNamed.map(r => r.sell_order_id))].sort(),
          });
        }
        await tx`DELETE FROM order_lines WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])`;

        // A scan key is NOT owned by the line that carries it: a partial
        // transfer clones scan_image_id onto a second line in the same order,
        // so deleting one of the pair would take the survivor's picture with
        // it. Photo storage_keys need no such test — each upload mints its own
        // key and the clone doesn't copy the rows.
        const doomedScans = doomed.map(r => r.scan_image_id).filter(Boolean) as string[];
        if (doomedScans.length) {
          const stillUsed = new Set((await tx`
            SELECT DISTINCT scan_image_id FROM order_lines
            WHERE scan_image_id = ANY(${doomedScans})
          ` as { scan_image_id: string }[]).map(r => r.scan_image_id));
          for (const k of doomedScans) if (!stillUsed.has(k)) removedScanKeys.push(k);
        }
      }
      if (Array.isArray(body.lines)) {
        // Re-read under the order lock. `storedById` was read on the pool
        // before the transaction and is right for the 400-level validation,
        // but it decides the spec-column clear below — and a concurrent patch
        // that committed a category switch in between leaves it claiming the
        // OLD category, so the clear is skipped and the row keeps columns the
        // category it now holds does not own.
        //
        // The lines are locked here too, in id order, after the order (the
        // one lock order — services/orderLocks.ts): a sell-order promotion
        // locks them to stake its claim, so the committed check below and
        // the qty write can't straddle one.
        const lockedById = new Map<string, StoredLine>();
        const lockedRows = await tx`
          SELECT ${storedLineCols(tx)}
          FROM order_lines
          WHERE order_id = ${id} AND id = ANY(${body.lines.map(l => l.id)}::uuid[])
          ORDER BY id
          FOR UPDATE
        ` as StoredLine[];
        for (const r of lockedRows) lockedById.set(r.id, r);

        // A qty edit may not drop below what committed sell orders hold: the
        // order would go on consuming units the line no longer has. Only this
        // PO's lines: another order's id is a no-op in the UPDATE below, so it
        // can't be what refuses the patch.
        const qtyEdits = body.lines.filter(l => l.qty !== undefined && l.qty !== null
          && lockedById.has(l.id.toLowerCase()));
        if (qtyEdits.length) {
          const claims = await committedClaimsByLine(tx, qtyEdits.map(l => l.id));
          const short = qtyEdits.filter(l => (claims.get(l.id.toLowerCase())?.qty ?? 0) > Number(l.qty));
          if (short.length) {
            throw new OrderRefusal({
              kind: 'qtyBelowCommitted',
              lineIds: short.map(l => l.id),
              sellOrderIds: [...new Set(short.map(l => claims.get(l.id.toLowerCase())!.sellOrderId))].sort(),
            });
          }
        }

        for (let l of body.lines) {
          const stored = lockedById.get(l.id);
          // Clear-then-apply. A line moving to a new category first has the old
          // category's spec columns NULLed (the COALESCE update below can only
          // write values, never clear them), then the normal update re-applies
          // whatever the patch carries for the new one.
          if (stored && l.category !== undefined && l.category !== stored.category) {
            const stale = staleSpecDbCols(l.category);
            if (stale.length) {
              await tx`
                UPDATE order_lines SET ${tx(Object.fromEntries(stale.map(col => [col, null])))}
                WHERE id = ${l.id} AND order_id = ${id}
              `;
            }
            // A synthetic part number describes the specs of the category it was
            // built from, so it has to be rebuilt — while a typed/OCR one is the
            // manufacturer's and stays. Never written back as NULL: inventory
            // grouping and reference pricing are both keyed on this column.
            const wasSynthetic = !!stored.part_number
              && stored.part_number === synthesizePartNumber(stored.category ?? '', {
                brand: stored.brand, capacity: stored.capacity, interface: stored.interface,
                formFactor: stored.form_factor, generation: stored.generation,
                speed: stored.speed, rpm: stored.rpm,
              });
            if (wasSynthetic) {
              const keep = (col: string) => !stale.includes(col);
              // What each spec will hold after the UPDATE below: a present
              // field lands as sent (cleared included), an absent one keeps the
              // stored value unless the category switch just cleared it.
              const sent = l as unknown as Record<string, unknown>;
              const after = (key: string, col: string, v: string | null | undefined): string | null =>
                sent[key] !== undefined ? specVal(v) : (keep(col) ? (stored as Record<string, unknown>)[col] as string | null : null);
              const rebuilt = synthesizePartNumber(l.category, {
                brand:       after('brand', 'brand', l.brand),
                capacity:    after('capacity', 'capacity', l.capacity),
                interface:   after('interface', 'interface', l.interface),
                formFactor:  after('formFactor', 'form_factor', l.formFactor),
                generation:  after('generation', 'generation', l.generation),
                speed:       after('speed', 'speed', l.speed),
                rpm:         sent.rpm !== undefined ? (l.rpm ?? null) : (keep('rpm') ? stored.rpm : null),
              });
              if (rebuilt) l = { ...l, partNumber: rebuilt };
            }
          }
          // One UPDATE per line, unlike the events below: each patch names its
          // own fields, and the sentinels/COALESCEs that keep the rest differ
          // per row — a single statement would need a sentinel per column.
          const setSellPrice = l.sellPrice !== undefined ? 1 : 0;
          const lineBody = l as unknown as Record<string, unknown>;
          const has = (f: string) => (lineBody[f] !== undefined ? 1 : 0);
          // `status` is deliberately NOT settable here. Line status is driven
          // by the lifecycle (advance handler) and 'Sold' is a protected
          // terminal state; accepting a client-supplied status would let any
          // editor forge 'Sold'/'Done' and defeat the sell-order/inventory
          // guards that key off it. order_lines.status has no CHECK, so this
          // route layer is the gate.
          await tx`
            UPDATE order_lines SET
              category       = COALESCE(${l.category ?? null}, category),
              sell_price     = CASE WHEN ${setSellPrice}::int = 1 THEN ${normSellPrice(l.sellPrice)} ELSE sell_price END,
              qty            = COALESCE(${l.qty ?? null}, qty),
              -- A partly sold line keeps what was bought in qty_purchased; a
              -- recount moves both by the same amount, so the sold units stay sold.
              qty_purchased  = CASE WHEN qty_purchased IS NULL OR ${l.qty ?? null}::int IS NULL
                                    THEN qty_purchased
                                    ELSE qty_purchased + (${l.qty ?? null}::int - qty) END,
              unit_cost      = COALESCE(${l.unitCost ?? null}, unit_cost),
              -- The fields the line editors own take a sentinel, not COALESCE:
              -- present (null included) is what lands, absent keeps the
              -- column. The editors echo every one of them back with its
              -- current value, so a blank one is the user clearing it, and
              -- COALESCE read that as "no change": the save said it worked and
              -- the value came back.
              brand          = CASE WHEN ${has('brand')}::int = 1          THEN ${specVal(l.brand)}          ELSE brand END,
              capacity       = CASE WHEN ${has('capacity')}::int = 1       THEN ${specVal(l.capacity)}       ELSE capacity END,
              type           = CASE WHEN ${has('type')}::int = 1           THEN ${specVal(l.type)}           ELSE type END,
              generation     = CASE WHEN ${has('generation')}::int = 1     THEN ${specVal(l.generation)}     ELSE generation END,
              classification = CASE WHEN ${has('classification')}::int = 1 THEN ${specVal(l.classification)} ELSE classification END,
              rank           = CASE WHEN ${has('rank')}::int = 1           THEN ${specVal(l.rank)}           ELSE rank END,
              speed          = CASE WHEN ${has('speed')}::int = 1          THEN ${specVal(l.speed)}          ELSE speed END,
              interface      = CASE WHEN ${has('interface')}::int = 1      THEN ${specVal(l.interface)}      ELSE interface END,
              form_factor    = CASE WHEN ${has('formFactor')}::int = 1     THEN ${specVal(l.formFactor)}     ELSE form_factor END,
              description    = CASE WHEN ${has('description')}::int = 1    THEN ${specVal(l.description)}    ELSE description END,
              item_type      = CASE WHEN ${has('itemType')}::int = 1       THEN ${specVal(l.itemType)}       ELSE item_type END,
              -- Never written back as NULL: inventory grouping and reference
              -- pricing are keyed on it.
              part_number    = COALESCE(${l.partNumber ?? null}, part_number),
              serial_number  = COALESCE(${l.serialNumber ?? null}, serial_number),
              chip_number    = CASE WHEN ${has('chipNumber')}::int = 1
                                    THEN NULLIF(${canonChipNumber(l.chipNumber)}, '') ELSE chip_number END,
              condition      = COALESCE(${l.condition ?? null}, condition),
              health         = CASE WHEN ${has('health')}::int = 1 THEN ${l.health ?? null} ELSE health END,
              rpm            = CASE WHEN ${has('rpm')}::int = 1    THEN ${l.rpm ?? null}    ELSE rpm END,
              scan_image_id  = COALESCE(${l.scanImageId ?? null}, scan_image_id),
              scan_confidence = COALESCE(${l.scanConfidence ?? null}, scan_confidence)
            WHERE id = ${l.id} AND order_id = ${id}
          `;
        }
      }
      let addedRows: LineSnapRow[] = [];
      if (Array.isArray(body.addLines) && body.addLines.length) {
        // New lines default to the order's category. Position appends after
        // current max so they sort to the end.
        const posRow = (await tx`SELECT COALESCE(MAX(position), -1) AS p FROM order_lines WHERE order_id = ${id}`)[0] as { p: number };
        const status = LINE_STATUS_FOR_LIFECYCLE[lifecycleAfter] ?? 'In Transit';
        const lineRows = body.addLines.map((l, i) => newLineRow(id, addCats[i], l, {
          qty: l.qty ?? 1, unitCost: l.unitCost ?? 0, status, position: posRow.p + 1 + i,
        }));
        // Re-sorted so addedLineIds lines up 1:1 with the request's addLines.
        const inserted = await tx<(LineSnapRow & { position: number })[]>`
          INSERT INTO order_lines ${tx(lineRows)}
          RETURNING id, category, part_number, qty, unit_cost::float AS unit_cost, position
        `;
        addedRows = [...inserted]
          .sort((a, b) => a.position - b.position)
          .map(({ position: _position, ...row }) => row);
        for (const r of addedRows) addedLineIds.push(r.id);
        await autoTrackParts(tx, body.addLines.map((l, i) => trackInput(l, addCats[i])));
      }

      // A PO that HAD lines may not be left with none. Both clients block it,
      // but the API did not, and an emptied order keeps the NOT NULL category
      // its last line derived — a chip with nothing behind it — while its goods
      // total resets to 0. An always-empty draft is untouched: it has nothing
      // to remove, so this can only fire on a request that removed something.
      if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id = ${id}
        `;
        if (n === 0) throw new OrderRefusal({ kind: 'orderWouldBeEmpty' });
      }

      // Category and goods total are both denormalizations of the lines,
      // recomputed after every add, remove and edit. Without this the tape
      // itemised categories that summed to one figure under a goods total that
      // still held the pre-edit one. Ahead of the audit block, not after it:
      // total_cost is one of META_FIELDS, so diffing before the derivation ran
      // left every goods-total move off the timeline.
      if (touchesLines) {
        await syncOrderCategory(tx, id);
        await syncOrderGoodsTotal(tx, id, goodsFollowsLines);
      }

      // ── Audit. Each kind is written as its own event row so the timeline
      // reads in the order it happened.
      //
      // Also entered on a lines-only patch: total_cost is a META_FIELD that the
      // derivation above may have just moved, and `diff` reports nothing when
      // it hasn't, so the extra read costs a query and never a false event.
      // Collected alongside the per-kind events below so a revert can carry
      // the whole change set on one row: the review dialog renders from it
      // without stitching sibling events together by timestamp.
      const revertFields: AuditChange[] = [];
      const revertLinesEdited: Array<Record<string, unknown>> = [];

      if (touchesOrder || touchesLines || packageChanged.length) {
        const orderAfter = (await tx`
          SELECT notes, warehouse_id, payment, payment_method, total_cost::float AS total_cost,
                 commission_rate::float AS commission_rate,
                 other_fees::float AS other_fees, other_fees_note, paypal_txn_id,
                 supplier_id, source, handoff_method, handoff_by
          FROM orders WHERE id = ${id} LIMIT 1
        `)[0] as Record<string, unknown>;
        const metaChanges = diff(
          orderBefore as unknown as Record<string, unknown>,
          orderAfter,
          META_FIELDS,
        );
        await nameHandoffByChange(tx, metaChanges);
        // The box's move rides the same event as the fields, so the timeline
        // and the change-review show one edit, not a field and a package.
        metaChanges.push(...packageChanged);
        if (metaChanges.length) {
          await writeOrderEvent(tx, id, u.id, 'meta_changed', { changes: metaChanges });
          revertFields.push(...metaChanges);
        }
      }
      // Fetch the post-write snapshot for every edited line in ONE query,
      // then walk the in-memory map. The previous per-line SELECT was an
      // N+1 inside the tx: a 50-line PATCH cost 50 sequential round trips
      // just to render the audit diff.
      const patches = body.lines ?? [];
      if (patches.length > 0) {
        const patchIds = patches.map(p => p.id);
        const afters = (await tx`
          SELECT ${lineAuditCols(tx)}
          FROM order_lines WHERE id = ANY(${patchIds}::uuid[])
        `) as Record<string, unknown>[];
        const afterMap = new Map<string, Record<string, unknown>>(
          afters.map(a => [a.id as string, a]),
        );
        for (const patch of patches) {
          const before = beforeMap.get(patch.id);
          const after = afterMap.get(patch.id);
          if (!before || !after) continue;
          const changes = diff(before, after, LINE_FIELDS);
          if (changes.length) {
            revertLinesEdited.push({
              lineId: patch.id,
              partNumber: after.part_number ?? null,
              changes,
            });
          }
        }
      }
      // One statement for every per-line event: a wide edit used to cost a
      // round trip per line.
      const lineEvents: { kind: EventKind; detail: Record<string, unknown> }[] = [
        ...revertLinesEdited.map(detail => ({ kind: 'line_edited' as const, detail })),
        ...addedRows.map(r => ({ kind: 'line_added' as const, detail: lineSnapshot(r) })),
        ...removedSnapshots.map(r => ({ kind: 'line_removed' as const, detail: lineSnapshot(r) })),
      ];
      if (lineEvents.length) {
        await tx`
          INSERT INTO order_events ${tx(
            // The helper's typing has no room for a json() parameter as a value.
            lineEvents.map(e => ({
              order_id: id, actor_id: u.id, kind: e.kind, detail: tx.json(e.detail as never),
            })) as never,
            'order_id', 'actor_id', 'kind', 'detail')}
        `;
      }

      if (revertedFrom) {
        await writeOrderEvent(tx, id, u.id, 'reverted', {
          from: revertedFrom,
          to: 'draft',
          fields: revertFields,
          lines: {
            added: addedRows.map(lineSnapshot),
            removed: removedSnapshots.map(lineSnapshot),
            edited: revertLinesEdited,
          },
        });
      }
    });
  } catch (e) {
    if (e instanceof OrderRefusal) return refusalResponse(c, u, e.refusal);
    // A line value outside a column's CHECK (health 0–100, rpm > 0, qty >= 0).
    if ((e as { code?: string }).code === '23514') {
      return c.json({ error: 'A line value is out of range' }, 400);
    }
    throw e;
  }

  // Best-effort R2 cleanup after a successful commit (stub/CF-era keys are
  // no-ops; a missing object delete is idempotent). Batched: this runs with the
  // response still open, and a wide removal used to mean one round trip per key.
  const unswept = await deleteAttachments(c.env, removedScanKeys);
  if (unswept.length) log.error('r2 delete (line removed)', unswept);
  registerIfNeeded(c.env, sql, packageToRegister, packageToRegister !== null);

  // The link count is the Payments page's figure — managers only, and left
  // out rather than zeroed for everyone else.
  return c.json({
    ok: true, addedLineIds, lifecycle: lifecycleAfter,
    ...(effectiveRole(u) === 'manager' ? { paymentsLinked } : {}),
  });
});

export default patchRoutes;
