// Per-status evidence (notes, attachments) and line photos.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { uploadAttachment, deleteAttachment } from '../../r2';
import { UUID_RE } from '../../lib/pagination';
import { writeOrderEvent, type SqlLike } from '../../services/orderAudit';
import { getUploadLimits } from '../../lib/settings';
import { isClosedBook } from '../../services/orderAdvance';
import { chatShotRequiredFor, cashShotRequiredFor } from '../../services/orderTxnRule';
import { LINE_PHOTO_CAP } from '@recycle-erp/shared';
import { type User } from '../../types';
import { extractPaypalTxn } from '../../ai/paypal';
import { maybeRenameReceipt, suffixFilename } from '../../ai/receipt';
import { shrinkImageToFit } from '../../lib/image-shrink';
import { log } from '../../lib/log';
import { type OrdersEnv } from './shared';
import { OrderRefusal, refusalResponse } from './refusal';

const evidenceRoutes = new Hono<OrdersEnv>();

// ─── Per-status evidence (note + attachments) ──────────────────────────────
// Optional evidence a manager can leave when moving a PO to Done. Same
// live-save contract as the sell-order endpoints: the dialog persists
// directly here, so files survive a cancelled status change. Statuses are a
// hardcoded map (no needs_meta table like sell orders), so the valid set is
// a constant.
const PO_META_STATUSES = new Set(['Submission', 'Done', 'Payment', 'Commission']);

// Submission evidence (receipts attached at submit time) is owner-editable: the
// purchaser who owns the order may add/remove files while it is still a Draft.
// Every other meta status (Done, Commission) remains manager-only.
// Writes, so the raw role: the preview is a viewing convenience, not a
// permission demotion (lib/role.ts).
function canWriteMeta(u: User, status: string, order: { user_id: string; lifecycle: string }): boolean {
  if (u.role === 'manager') return true;
  // Submission evidence belongs to the purchaser who raised the PO and stays
  // theirs until the review closes — a receipt or a photo of the goods
  // routinely shows up after the order has already moved to In Transit or
  // Reviewing.
  // Payment proof — the cash screenshot — is the purchaser's on the same
  // terms: it is what lets their own order leave Draft.
  return (status === 'Submission' || status === 'Payment')
    && order.user_id === u.id && !isClosedBook(order.lifecycle);
}

type OrderAccess = { user_id: string; lifecycle: string };

// The unlocked read the evidence routes judge permission on.
async function loadOrderAccess(sql: SqlLike, id: string): Promise<OrderAccess | undefined> {
  return (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | OrderAccess | undefined;
}

type LockedOrderAccess = OrderAccess & {
  payment: string; payment_method: string | null; created_at: Date;
};

// The same row under FOR NO KEY UPDATE, for the writes: the unlocked read above can
// be seconds stale by the time the file is stored, and the lock is what keeps
// an advance from closing the book between the check and the write. The
// payment fields are what the proof rules key on.
async function lockOrderAccess(tx: SqlLike, id: string): Promise<LockedOrderAccess | undefined> {
  return (await tx`
    SELECT user_id, lifecycle, payment, payment_method, created_at
    FROM orders WHERE id = ${id} LIMIT 1 FOR NO KEY UPDATE
  `)[0] as LockedOrderAccess | undefined;
}

// Upsert the text note for a single (order, status).
evidenceRoutes.put('/:id/status-meta/:status', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const status = c.req.param('status');
  if (!PO_META_STATUSES.has(status)) return c.json({ error: 'invalid status' }, 400);
  const body = (await c.req.json().catch(() => null)) as { note?: string | null } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);

  // Ensure the order exists; otherwise the FK upsert silently inserts.
  const existing = await loadOrderAccess(sql, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);

  const note = (body.note ?? '').trim() || null;
  await sql.begin(async (tx) => {
    const before = (await tx<{ note: string | null }[]>`
      SELECT note FROM order_status_meta
      WHERE order_id = ${id} AND status = ${status} LIMIT 1
    `)[0];
    await tx`
      INSERT INTO order_status_meta (order_id, status, note, set_by)
      VALUES (${id}, ${status}, ${note}, ${u.id})
      ON CONFLICT (order_id, status)
      DO UPDATE SET note = EXCLUDED.note, set_at = NOW(), set_by = EXCLUDED.set_by
    `;
    const fromNote = before?.note ?? null;
    if (fromNote !== note) {
      await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'note', from: fromNote, to: note,
      });
    }
  });
  return c.json({ ok: true });
});

// Upload one attachment for (order, status). Multipart with field `file`.
// `?scan=paypal` on the Payment bucket also reads the PayPal transaction id
// off the image and returns it beside the attachment, so the cost-payment
// screenshot is stored and read in one upload instead of a scan call whose
// object nothing ever recorded. The id is read before the file is stored so
// the stored name carries it (`<date>-paypal-<amount>-<TXNID>.jpg`) and a
// chip in the attachment list matches a ledger row without opening the
// image. The read is best-effort: a failed OCR keeps the file under its plain
// name and answers `scan: null`. No scan rate limit here, on the same footing
// as the receipt rename (one model call per upload already).
evidenceRoutes.post('/:id/status-meta/:status/attachments', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const status = c.req.param('status');
  if (!PO_META_STATUSES.has(status)) return c.json({ error: 'invalid status' }, 400);
  const scanPaypal = status === 'Payment' && c.req.query('scan') === 'paypal';

  const sql = getDb(c.env);
  const existing = await loadOrderAccess(sql, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  // These files land in the PUBLIC R2 bucket and are served with their
  // declared Content-Type — an unchecked HTML/SVG is a stored-XSS vector.
  // A missing type is rejected (not allowed through as octet-stream).
  if (!file.type || !allowedMime.has(file.type)) {
    return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
  }
  // Oversized images are downscaled to fit the cap rather than rejected —
  // receipts arrive as multi-MB phone screenshots. Non-images (PDF) can't be
  // recompressed and fall through to the 413.
  const fitted = await shrinkImageToFit(file, maxBytes);
  if (fitted.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  // Every PO meta status holds a payment receipt of some kind, so the AI
  // rename applies unconditionally — no per-status gate like sell orders.
  // The PayPal read is a second model call on the same bytes, so it runs
  // alongside rather than after.
  const wantScan = scanPaypal && fitted.type.startsWith('image/');
  const [renamed, scan] = await Promise.all([
    maybeRenameReceipt(c.env, fitted),
    wantScan
      ? extractPaypalTxn(c.env, await fitted.arrayBuffer()).catch((e): null => {
          log.warn('paypal scan on payment attachment failed', e);
          return null;
        })
      : null,
  ]);
  const stored = scan?.txnId
    ? new File([renamed], suffixFilename(renamed.name, scan.txnId), { type: renamed.type })
    : renamed;

  // R2 upload happens outside the transaction — it's the slow part.
  const uploaded = await uploadAttachment(c.env, stored, `orders/${id}/${status}`)
    .catch(e => { log.error('attachment upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  type AttachmentRow = {
    id: string; filename: string; size_bytes: number; mime_type: string;
    delivery_url: string; uploaded_at: Date;
  };
  let row: AttachmentRow;
  try {
    row = await sql.begin(async (tx) => {
      // Re-checked under the lock, as the photo upload does: the permission
      // read happened before the shrink, the OCR and the R2 round trip —
      // seconds a manager can spend closing the book on the order.
      const live = await lockOrderAccess(tx, id);
      if (!live) throw new OrderRefusal({ kind: 'orderGone' });
      if (!canWriteMeta(u, status, live)) throw new OrderRefusal({ kind: 'forbidden' });
      const r = (await tx<AttachmentRow[]>`
        INSERT INTO order_status_attachments
          (order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
        VALUES
          (${id}, ${status}, ${stored.name}, ${stored.size},
           ${stored.type || 'application/octet-stream'},
           ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${u.id})
        RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
      `)[0];
      await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'attachment_added',
        attachmentId: r.id, filename: r.filename, size: r.size_bytes, mime: r.mime_type,
      });
      return r;
    });
  } catch (e) {
    // The object went up first, so any rollback leaves it in R2 with no row
    // naming it, where nothing can find it again.
    await deleteAttachment(c.env, uploaded.storageKey).catch(() => { /* best-effort */ });
    if (e instanceof OrderRefusal) return refusalResponse(c, u, e.refusal);
    throw e;
  }

  const attachment = {
    id: row.id,
    filename: row.filename,
    size: row.size_bytes,
    mime: row.mime_type,
    url: row.delivery_url,
    uploadedAt: row.uploaded_at,
  };
  return c.json(wantScan ? { attachment, scan } : { attachment });
});

// Remove a single attachment.
evidenceRoutes.delete('/:id/status-meta/:status/attachments/:attachmentId', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const status = c.req.param('status');
  const attachmentId = c.req.param('attachmentId');
  if (!PO_META_STATUSES.has(status)) return c.json({ error: 'invalid status' }, 400);

  const sql = getDb(c.env);
  const existing = await loadOrderAccess(sql, id);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);

  const removed = await sql.begin(async (tx): Promise<
    | { kind: 'notFound' } | { kind: 'forbidden' } | { kind: 'lastProof' }
    | { kind: 'ok'; storage_key: string }
  > => {
    const live = await lockOrderAccess(tx, id);
    if (!live) return { kind: 'notFound' };
    if (!canWriteMeta(u, status, live)) return { kind: 'forbidden' };
    const row = (await tx`
      SELECT storage_key, filename FROM order_status_attachments
      WHERE id = ${attachmentId} AND order_id = ${id} AND status = ${status}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return { kind: 'notFound' };
    // The purchaser keeps their evidence until the review closes — receipts
    // get swapped for better ones — but once the order is submitted, the one
    // file a proof rule let it leave Draft on is what the review is judging.
    // Deleting the last of those would leave a submitted order that could
    // never have been submitted. A manager can always clean up.
    if (u.role !== 'manager' && live.lifecycle !== 'draft') {
      const required = status === 'Submission' ? await chatShotRequiredFor(tx, live)
        : status === 'Payment' ? await cashShotRequiredFor(tx, live)
        : false;
      if (required) {
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM order_status_attachments
          WHERE order_id = ${id} AND status = ${status}
        `;
        if (n <= 1) return { kind: 'lastProof' };
      }
    }
    await tx`DELETE FROM order_status_attachments WHERE id = ${attachmentId}`;
    await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
      status, field: 'attachment_removed',
      attachmentId, filename: row.filename,
    });
    return { kind: 'ok', storage_key: row.storage_key };
  });

  if (removed.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (removed.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (removed.kind === 'lastProof') {
    return c.json({
      error: status === 'Submission'
        ? 'This is the only chat screenshot on a submitted self-paid order — upload a replacement before removing it.'
        : 'This is the only payment screenshot on a submitted cash order — upload a replacement before removing it.',
    }, 409);
  }
  // R2 delete outside the tx — slow side effect, kept out of the lock window.
  // Best-effort.
  await deleteAttachment(c.env, removed.storage_key).catch(e => log.error('r2 delete', e));
  return c.json({ ok: true });
});

// ─── Per-line photos ───────────────────────────────────────────────────────
// A picture of the actual goods, attached to one line. Distinct from the
// order-level Submission evidence above (that is the receipt for the whole
// PO) and from the AI label scan (that is a by-product of OCR, and only RAM
// lines ever get one). Any line may carry photos. The cap is shared so the
// picker stops at the same number this route enforces.

// order_lines.id is uuid-typed, so a mangled id would make Postgres throw and
// 500 the route rather than 404 cleanly — the routes below check UUID_RE first.

// The purchaser who raised the PO photographs the goods, and pictures keep
// arriving after it has moved to In Transit — so ownership lasts until the
// review closes, mirroring the Submission-evidence rule in canWriteMeta.
function canWritePhotos(u: User, order: { user_id: string; lifecycle: string }): boolean {
  if (u.role === 'manager') return true;
  return order.user_id === u.id && !isClosedBook(order.lifecycle);
}

// Resolves the order + verifies the line belongs to it. A lineId from another
// order must 404, not silently attach across POs.
async function loadPhotoTarget(
  sql: ReturnType<typeof getDb>,
  orderId: string,
  lineId: string,
): Promise<OrderAccess | null> {
  if (!UUID_RE.test(lineId)) return null;
  const row = (await sql`
    SELECT o.user_id, o.lifecycle,
           EXISTS (SELECT 1 FROM order_lines ol
                   WHERE ol.id = ${lineId}::uuid AND ol.order_id = o.id) AS has_line
    FROM orders o WHERE o.id = ${orderId} LIMIT 1
  `)[0] as (OrderAccess & { has_line: boolean }) | undefined;
  return row?.has_line ? { user_id: row.user_id, lifecycle: row.lifecycle } : null;
}

evidenceRoutes.post('/:id/lines/:lineId/photos', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const sql = getDb(c.env);

  const order = await loadPhotoTarget(sql, id, lineId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canWritePhotos(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);

  // Images only. The workspace allow-list also permits PDF/XLSX for receipts,
  // but a spreadsheet is not a photo of a DIMM — narrowing here keeps the
  // thumbnail grid renderable, the same way routes/scan.ts does.
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  if (!file.type || !file.type.startsWith('image/') || !allowedMime.has(file.type)) {
    return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
  }
  const fitted = await shrinkImageToFit(file, maxBytes);
  if (fitted.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  // No maybeRenameReceipt — that AI rename reads payment receipts, and these
  // are pictures of hardware.
  const uploaded = await uploadAttachment(c.env, fitted, `orders/${id}/lines/${lineId}`)
    .catch(e => { log.error('line photo upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  try {
    const row = await sql.begin(async (tx) => {
      // Lock the ORDER first, then the line — the same order PATCH /:id and
      // /advance take. Locking the line first used to deadlock against them
      // when they held FOR UPDATE on the order (the INSERT's FK check needs
      // FOR KEY SHARE on it); every non-deleting order lock is FOR NO KEY
      // UPDATE now, but orders-before-lines is still the one lock order.
      const live = (await tx`
        SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR NO KEY UPDATE
      `)[0] as { user_id: string; lifecycle: string } | undefined;
      // Re-checked under the lock: the permission read happened before the
      // image shrink and the R2 round trip, seconds a manager can spend
      // advancing the order to Done out from under it.
      if (!live) throw new OrderRefusal({ kind: 'orderGone' });
      if (!canWritePhotos(u, live)) throw new OrderRefusal({ kind: 'forbidden' });

      // Serialise concurrent uploads on the parent line — two racing requests
      // would otherwise both see room under the cap and both insert. The lock
      // goes on order_lines because FOR UPDATE can't be combined with the
      // aggregate below.
      await tx`SELECT 1 FROM order_lines WHERE id = ${lineId}::uuid FOR UPDATE`;
      const existing = (await tx`
        SELECT COALESCE(MAX(position), -1) AS max_pos, COUNT(*)::int AS n
        FROM order_line_photos WHERE order_line_id = ${lineId}::uuid
      `)[0] as { max_pos: number; n: number };
      if (existing.n >= LINE_PHOTO_CAP) throw new OrderRefusal({ kind: 'photoCap', cap: LINE_PHOTO_CAP });
      const r = (await tx`
        INSERT INTO order_line_photos
          (order_line_id, order_id, filename, size_bytes, mime_type, storage_key, delivery_url, position, uploaded_by)
        VALUES
          (${lineId}::uuid, ${id}, ${fitted.name}, ${fitted.size},
           ${fitted.type || 'image/jpeg'},
           ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${existing.max_pos + 1}, ${u.id})
        RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
      `)[0];
      await writeOrderEvent(tx, id, u.id, 'line_photo_added', {
        lineId, photoId: r.id, filename: r.filename, size: r.size_bytes, mime: r.mime_type,
      });
      return r;
    });
    return c.json({
      photo: {
        id: row.id, url: row.delivery_url, source: 'upload',
        filename: row.filename, size: row.size_bytes, mime: row.mime_type,
        uploadedAt: row.uploaded_at,
      },
    });
  } catch (e) {
    // The upload precedes the transaction, so ANY rollback — the cap, a
    // serialization failure, a pool timeout — leaves an object in R2 that no
    // row owns. Nothing else can find it later: both cleanup paths (order
    // delete and the removeLineIds sweep) read their keys out of
    // order_line_photos, and the row is exactly what didn't commit.
    await deleteAttachment(c.env, uploaded.storageKey).catch(() => { /* best-effort */ });
    if (e instanceof OrderRefusal) return refusalResponse(c, u, e.refusal);
    throw e;
  }
});

evidenceRoutes.delete('/:id/lines/:lineId/photos/:photoId', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const photoId = c.req.param('photoId');
  const sql = getDb(c.env);

  // A scan-sourced photo is addressed as `scan:<key>`, which is not a UUID —
  // it belongs to label_scans and is removed by re-scanning, not from here.
  if (!UUID_RE.test(photoId)) return c.json({ error: 'Not found' }, 404);

  const order = await loadPhotoTarget(sql, id, lineId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canWritePhotos(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const removed = await sql.begin(async (tx): Promise<
    { kind: 'notFound' } | { kind: 'forbidden' } | { kind: 'ok'; storage_key: string }
  > => {
    // Orders row first, as everywhere else that writes under this order — the
    // photo delete touches a table whose FK makes Postgres take KEY SHARE on
    // it anyway, so taking it in the other order deadlocks against PATCH.
    // Permission is re-judged on the locked row: the read above is unlocked,
    // and an advance past review can land between the two.
    const live = await lockOrderAccess(tx, id);
    if (!live) return { kind: 'notFound' };
    if (!canWritePhotos(u, live)) return { kind: 'forbidden' };
    const row = (await tx`
      SELECT storage_key, filename FROM order_line_photos
      WHERE id = ${photoId}::uuid AND order_line_id = ${lineId}::uuid AND order_id = ${id}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return { kind: 'notFound' };
    await tx`DELETE FROM order_line_photos WHERE id = ${photoId}::uuid`;
    await writeOrderEvent(tx, id, u.id, 'line_photo_removed', {
      lineId, photoId, filename: row.filename,
    });
    return { kind: 'ok', storage_key: row.storage_key };
  });

  if (removed.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (removed.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  await deleteAttachment(c.env, removed.storage_key).catch(e => log.error('r2 delete (line photo)', e));
  return c.json({ ok: true });
});

export default evidenceRoutes;
