// A draft PO minted outside the submit form's full create: the phone's
// autosave shell (POST /orders/draft) and a tracked package's create-po both
// go through here so the id mint, the draft INSERT, and the empty `created`
// event can't drift apart per site. Runs inside the caller's transaction.

import { nextHumanId } from '../lib/id-seq';
import { writeOrderEvent, type SqlLike } from './orderAudit';

export async function insertDraftOrderTx(tx: SqlLike, opts: {
  ownerId: string;
  /** Who performed the create — audited, and compared against ownerId for the
   *  on-behalf event fields. */
  actorId: string;
  /** Omitted → the NOT NULL column holds the 'Mixed' placeholder and the
   *  created event carries no category key (the timeline interpolates whatever
   *  is there, and a null once rendered as the literal text "null"). */
  category?: string;
  warehouseId: string | null;
  payment?: 'company' | 'self';
  notes?: string | null;
  /** Payment reference carried over from a tracked package's screenshot scan. */
  paypalTxnId?: string | null;
  /** The client this was bought from, when a tracked package's seller name
   *  already matches one. Keeps the package -> PO path attributed. */
  supplierId?: string | null;
  /** Only read when ownerId !== actorId. */
  onBehalfOfName?: string | null;
}): Promise<string> {
  const orderId = await nextHumanId(tx, 'PO', 'PO');
  await tx`
    INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle, paypal_txn_id, supplier_id)
    VALUES (
      ${orderId}, ${opts.ownerId}, ${opts.category ?? 'Mixed'}, ${opts.warehouseId},
      ${opts.payment ?? 'company'}, ${opts.notes ?? null}, ${null}, 'draft', ${opts.paypalTxnId ?? null},
      ${opts.supplierId ?? null}
    )
  `;
  await writeOrderEvent(tx, orderId, opts.actorId, 'created', {
    ...(opts.category ? { category: opts.category } : {}),
    categories: [],
    lineCount: 0,
    qty: 0,
    totalCost: null,
    ...(opts.ownerId !== opts.actorId
      ? { onBehalfOfUserId: opts.ownerId, onBehalfOfName: opts.onBehalfOfName ?? null }
      : {}),
  });
  return orderId;
}
