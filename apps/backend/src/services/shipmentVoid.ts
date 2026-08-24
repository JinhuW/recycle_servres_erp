// The void side of a shipment, extracted from POST /:sid/void so the tracking
// poll can apply an externally-voided label (cancelled on the ShipSaving
// dashboard) through the exact same fee reversal and audit trail. Without
// this, the poll marking a row 'voided' made the /void route 409 ('voided' is
// terminal) and stranded the label cost in the PO's other_fees forever.
//
// Must run inside the caller's transaction; locks the orders row first so the
// fee math can't interleave with a concurrent buy/void on the same PO.

import { writeOrderEvent } from './orderAudit';
import type { SqlLike } from './orderAudit';
import { notifyManagers } from '../lib/notify';

// The note column caps at this length everywhere it's written (see orders.ts).
export const FEE_NOTE_MAX = 280;

// null actor = the system (tracking poll observed an external void).
export type VoidActor = { id: string; name: string } | null;

export async function voidShipmentTx(
  tx: SqlLike,
  args: {
    orderId: string;
    sid: string;
    trackingNumber: string | null;
    carrier: string | null;
    actor: VoidActor;
  },
): Promise<void> {
  const { orderId, sid, trackingNumber, carrier, actor } = args;
  await tx`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;
  // Read the latch before clearing it (UPDATE … RETURNING yields new values,
  // not old ones), all under the same row lock.
  const prev = (await tx`
    SELECT fees_applied, label_cost::float AS label_cost FROM shipments WHERE id = ${sid} FOR UPDATE
  `)[0] as { fees_applied: boolean; label_cost: number | null };
  await tx`UPDATE shipments SET status = 'voided', fees_applied = FALSE WHERE id = ${sid}`;
  if (prev.fees_applied && prev.label_cost) {
    // GREATEST: a manual fee edit may have lowered other_fees below the
    // label cost since the buy; the column carries CHECK (>= 0).
    await tx`
      UPDATE orders SET
        other_fees = GREATEST(other_fees - ${prev.label_cost}, 0),
        other_fees_note = left(
          concat_ws(' | ', nullif(other_fees_note, ''), ${'Label voided ' + (trackingNumber ?? sid)}::text),
          ${FEE_NOTE_MAX}::int
        )
      WHERE id = ${orderId}
    `;
  }
  await writeOrderEvent(tx, orderId, actor?.id ?? null, 'shipment_voided', {
    shipmentId: sid,
    trackingNumber,
    amount: prev.label_cost,
  });
  await notifyManagers(tx, {
    kind: 'shipment_voided',
    tone: 'warn',
    icon: 'package',
    title: `Shipping label voided on ${orderId}`,
    body: actor
      ? `${actor.name} voided ${carrier ?? ''} ${trackingNumber ?? ''}`.trim()
      : `${carrier ?? ''} ${trackingNumber ?? ''} was voided outside the app — its cost was removed from the PO`.trim(),
  });
}
