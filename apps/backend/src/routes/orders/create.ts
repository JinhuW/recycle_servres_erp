// Creating POs: a submitted order with its lines, and the empty Draft the
// submit screen autosaves into.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { nextHumanId } from '../../lib/id-seq';
import { writeOrderEvent } from '../../services/orderAudit';
import { autoTrackParts } from '../../lib/marketAutoTrack';
import { specRuleErr, validateLineInput } from '../../lib/orderInput';
import { syncOrderCategory, deriveCategory } from '../../services/orderCategory';
import { insertDraftOrderTx } from '../../services/orderDraft';
import { linkPaypalTxnToOrder } from '../../banktx/sync';
import { syncOrderGoodsTotal } from '../../services/orderGoodsTotal';
import { serialIssue } from '@recycle-erp/shared';
import { type LineCategory } from '../../types';
import { normPaypalTxnId } from '../../ai/paypal';
import { type OrdersEnv, assertCategoriesEnabled, badFees, identityErr, isOrderPayment, isPaymentMethod, type LineInput, newLineRow, normFeeNote, resolveOrderOwner, serialErr, supplierErr, trackInput, warehouseErr } from './shared';

const createRoutes = new Hono<OrdersEnv>();

// ── Create a new order with its lines (purchaser submits from phone).
createRoutes.post('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        // Optional since a PO may mix categories: it is only a fallback for
        // lines that don't name their own. The stored order category is
        // derived from the lines (see syncOrderCategory).
        category?: LineCategory;
        warehouseId?: string;
        payment?: 'company' | 'self';
        /** How the company card paid. Meaningless — and dropped — for a
         *  self-paid PO. */
        paymentMethod?: 'paypal' | 'cash' | null;
        notes?: string;
        totalCost?: number;
        otherFees?: number;
        otherFeesNote?: string | null;
        onBehalfOfUserId?: string;
        /** The client we bought from. Optional — a PO can be filed before
         *  anyone says who it came from. */
        supplierId?: string | null;
        /** The payment that funded it. A company-paid PO can't leave Draft
         *  without one, so the create path has to be able to carry it. */
        paypalTxnId?: string | null;
        lines: LineInput[];
      }
    | null;
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'at least one product is required' }, 400);
  }
  const owner = await resolveOrderOwner(sql, u, body.onBehalfOfUserId);
  if ('error' in owner) return c.json({ error: owner.error }, owner.status);
  const whErr = await warehouseErr(sql, body.warehouseId ?? null);
  if (whErr) return c.json({ error: whErr }, 400);
  // Same canon and cap as PATCH and the add-package boundary, so an id that
  // arrives here diffs clean against one typed or OCR'd later.
  if (typeof body.paypalTxnId === 'string' && body.paypalTxnId.replace(/\s+/g, '').length > 64) {
    return c.json({ error: 'paypalTxnId is too long' }, 400);
  }
  const newPaypalTxnId = normPaypalTxnId(body.paypalTxnId);
  if (!isOrderPayment(body.payment)) return c.json({ error: 'payment must be company or self' }, 400);
  if (!isPaymentMethod(body.paymentMethod)) {
    return c.json({ error: 'paymentMethod must be paypal or cash' }, 400);
  }
  const newPaymentMethod = (body.payment ?? 'company') === 'company' ? (body.paymentMethod ?? null) : null;
  const supErr = await supplierErr(sql, u, body.supplierId ?? null);
  if (supErr) return c.json({ error: supErr }, 400);
  // No warehouse named → the owner's home warehouse (FK-valid by construction).
  // The owner's, not the actor's: a manager filing on behalf ships to the
  // purchaser's location.
  const warehouseId = body.warehouseId ?? owner.ownerDefaultWarehouseId;
  // A new PO sends every row in list order, so the nth is the page's "new n".
  // Read as unknown: a refused line is named by the very field it was refused for.
  const refOf = (i: number): string => {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const name = text(body.lines[i].partNumber) || text(body.lines[i].description);
    return name ? `new product ${i + 1} (${name})` : `new product ${i + 1}`;
  };
  const lineCats: string[] = [];
  for (let i = 0; i < body.lines.length; i++) {
    const raw: unknown = body.lines[i];
    if (typeof raw !== 'object' || raw === null) {
      return c.json({ error: `new product ${i + 1}: must be an object` }, 400);
    }
    const inputErr = validateLineInput(body.lines[i] as Record<string, unknown>, 'create');
    if (inputErr) return c.json({ error: `${refOf(i)}: ${inputErr}` }, 400);
    const cat = body.lines[i].category ?? body.category;
    if (!cat) return c.json({ error: `${refOf(i)}: category is required` }, 400);
    lineCats.push(cat);
  }

  // Every category a line claims must exist and be enabled — checked per line,
  // not once on the order, now that one PO can span several.
  const catErr = await assertCategoriesEnabled(sql, lineCats);
  if (catErr) return c.json({ error: catErr }, 400);

  const feeErr = badFees(body);
  if (feeErr) return c.json({ error: feeErr }, 400);

  for (let i = 0; i < body.lines.length; i++) {
    const l = body.lines[i];
    const issue = serialIssue({ ...l, category: lineCats[i] });
    if (issue) return c.json({ error: serialErr(refOf(i), issue) }, 400);
    const labelErr = identityErr(refOf(i), lineCats[i], l);
    if (labelErr) return c.json({ error: labelErr }, 400);
    const specErr = specRuleErr(refOf(i), lineCats[i], l);
    if (specErr) return c.json({ error: specErr }, 400);
  }

  // Human-friendly id like PO-1289, allocated atomically (see id-seq.ts).
  // Allocated inside the transaction so a rollback also rolls back the counter.
  let newId!: string;
  // Returned so the client can attach per-line photos, which are buffered
  // locally until the line it belongs to actually exists, and show each
  // product's #. Aligned 1:1 with the request's `lines` ordering, the same
  // contract PATCH's addedLineIds has.
  const newLineIds: string[] = [];
  const newLineNos: number[] = [];
  let derived: { category: string | null; categories: string[] } = { category: null, categories: [] };
  await sql.begin(async (tx) => {
    newId = await nextHumanId(tx, 'PO', 'PO');
    await tx`
      INSERT INTO orders (
        id, user_id, category, warehouse_id, payment, payment_method, notes, total_cost,
        other_fees, other_fees_note, lifecycle, supplier_id, paypal_txn_id
      )
      VALUES (
        ${newId}, ${owner.ownerId}, ${deriveCategory(lineCats) ?? lineCats[0]},
        ${warehouseId}, ${body.payment ?? 'company'}, ${newPaymentMethod}, ${body.notes ?? null},
        ${body.totalCost ?? null},
        ${body.otherFees ?? 0}, ${normFeeNote(body.otherFeesNote)}, 'draft',
        ${body.supplierId ?? null}, ${newPaypalTxnId}
      )
    `;
    const lineRows = body.lines.map((l, i) => newLineRow(newId, lineCats[i], l, {
      qty: l.qty, unitCost: l.unitCost, status: 'Draft', position: i,
    }));
    // RETURNING carries no promise about row order; the # (0169's trigger,
    // numbering the VALUES in order) is the request's.
    const inserted = await tx<{ id: string; product_no: number }[]>`
      INSERT INTO order_lines ${tx(lineRows)} RETURNING id, product_no
    `;
    for (const r of [...inserted].sort((a, b) => a.product_no - b.product_no)) {
      newLineIds.push(r.id);
      newLineNos.push(r.product_no);
    }
    await autoTrackParts(tx, body.lines.map((l, i) => trackInput(l, lineCats[i])));

    // Written before the event so `created` carries the value the order
    // actually ended up with rather than whatever the client proposed.
    derived = await syncOrderCategory(tx, newId);
    // The goods total follows the lines unless this request stated one of its
    // own — the create path is the one place a negotiated lot price can still
    // enter, since no screen offers a field for it any more. Zero is not one
    // of those: taking it literally pinned the column at $0 against real lines
    // with nothing left anywhere able to correct it.
    await syncOrderGoodsTotal(tx, newId, !(Number(body.totalCost) > 0));

    // Baseline of the timeline. Without it a freshly-created PO reads as an
    // order with no history at all until someone submits it.
    await writeOrderEvent(tx, newId, u.id, 'created', {
      category: derived.category,
      categories: derived.categories,
      lineCount: body.lines.length,
      qty: body.lines.reduce((s, l) => s + Number(l.qty ?? 0), 0),
      totalCost: body.totalCost ?? null,
      otherFees: body.otherFees ?? 0,
      // Present only when a manager filed the PO for someone else, so the
      // timeline can say who the order was created for. The name is snapshot
      // here because events render without joining users on the owner.
      ...(owner.ownerId !== u.id
        ? { onBehalfOfUserId: owner.ownerId, onBehalfOfName: owner.ownerName }
        : {}),
    });

    if (newPaypalTxnId) await linkPaypalTxnToOrder(tx, newPaypalTxnId, newId, u.id);
  });

  return c.json({ id: newId, lineIds: newLineIds, lineNos: newLineNos }, 201);
});

// ── Create an empty Draft order so the submit screen can autosave lines as
// the purchaser builds them (nothing is lost if they leave mid-entry).
createRoutes.post('/draft', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        category?: LineCategory; warehouseId?: string; payment?: 'company' | 'self';
        notes?: string; onBehalfOfUserId?: string;
      }
    | null;

  const owner = await resolveOrderOwner(sql, u, body?.onBehalfOfUserId);
  if ('error' in owner) return c.json({ error: owner.error }, owner.status);

  // No category required: the draft is empty, and the order's category is
  // derived from lines that don't exist yet. The column is NOT NULL, so an
  // uncommitted draft holds 'Mixed' as a placeholder — clients render the chip
  // from `categories`, which is empty, so the placeholder never surfaces.
  if (body?.category) {
    const catErr = await assertCategoriesEnabled(sql, [body.category]);
    if (catErr) return c.json({ error: catErr }, 400);
  }

  if (!isOrderPayment(body?.payment)) return c.json({ error: 'payment must be company or self' }, 400);
  const whErr = await warehouseErr(sql, body?.warehouseId ?? null);
  if (whErr) return c.json({ error: whErr }, 400);
  // No warehouse named → the owner's home warehouse (FK-valid by construction).
  const warehouseId = body?.warehouseId ?? owner.ownerDefaultWarehouseId;

  // Allocated inside the transaction so a rollback also rolls back the counter.
  let newId!: string;
  await sql.begin(async (tx) => {
    newId = await insertDraftOrderTx(tx, {
      ownerId: owner.ownerId,
      actorId: u.id,
      category: body?.category,
      warehouseId,
      payment: body?.payment,
      notes: body?.notes,
      onBehalfOfName: owner.ownerName,
    });
  });

  return c.json({ id: newId }, 201);
});

export default createRoutes;
