// The Draft → In Transit hand-off, as one transaction: the dialog's fields are
// written to the order, a pasted tracking number becomes a package linked to
// it, and the advance runs through the same guards as POST /advance. Any
// refusal rolls the whole thing back — three separate calls left a package
// linked to a Draft that then failed the proof rule, and a purchaser holding a
// half-written order to re-present.
//
// Validation of the request body is the route's job (it runs on the pool
// before the transaction, like PATCH); this file trusts its input.

import type { Carrier, PackageSource } from '@recycle-erp/shared';
import { linkPaypalTxnToOrder } from '../banktx/sync';
import { advanceOrderTx, type AdvanceActor, type AdvanceOutcome } from './orderAdvance';
import { diff, writeOrderEvent, type SqlLike } from './orderAudit';

export type HandoffInput = {
  warehouseId: string;
  source: PackageSource;
  handoff:
    | { method: 'pickup'; byUserId: string; byName: string }
    | { method: 'label'; trackingNumber: string; carrier: Carrier };
  payment: 'company' | 'self';
  /** Company card only; a self-paid order carries none. */
  paymentMethod: 'paypal' | 'cash' | null;
  /** Already normalised (no whitespace, upper-case) by the route. */
  paypalTxnId: string | null;
  paymentScreenshotKey: string | null;
  paymentScreenshotUrl: string | null;
  /** Manager-only, resolved by the route. Undefined leaves the owner alone. */
  newOwner?: { ownerId: string; ownerName: string | null };
  /** Manager-only, already clamped. Undefined leaves the rate alone. */
  commissionRate?: number | null;
};

export type HandoffRefusal =
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'archived' }
  | { kind: 'notDraft'; lifecycle: string }
  | { kind: 'trackingTaken' }
  | { kind: 'advance'; outcome: Exclude<AdvanceOutcome, { kind: 'ok' }> };

// Thrown from inside sql.begin so the transaction unwinds; the route turns it
// back into a response.
export class HandoffRefused extends Error {
  constructor(public readonly refusal: HandoffRefusal) {
    super(`handoff refused: ${refusal.kind}`);
  }
}

export type HandoffPackage = { id: string; tracking_number: string; carrier: string };

const HANDOFF_FIELDS = [
  'warehouse_id', 'source', 'handoff_method', 'handoff_by', 'payment', 'payment_method',
  'paypal_txn_id', 'commission_rate',
] as const;

type OrderRow = {
  id: string; user_id: string; lifecycle: string; archived_at: Date | null;
  warehouse_id: string | null; source: string | null; handoff_method: string | null;
  handoff_by: string | null; payment: string; payment_method: string | null;
  paypal_txn_id: string | null; commission_rate: number | null;
  supplier_name: string | null;
};

/** An active member by id, for the "Picked up by" picker. Null when unknown
 *  or deactivated. The caller has already checked the id is uuid-shaped. */
export async function activeMember(
  sql: SqlLike, id: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM users WHERE id = ${id} AND COALESCE(active, TRUE) LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function handoffOrderTx(
  tx: SqlLike,
  id: string,
  actor: NonNullable<AdvanceActor>,
  input: HandoffInput,
): Promise<{ package: HandoffPackage | null; paymentsLinked: number }> {
  const before = (await tx`
    SELECT o.id, o.user_id, o.lifecycle, o.archived_at, o.warehouse_id, o.source,
           o.handoff_method, o.handoff_by, o.payment, o.payment_method, o.paypal_txn_id,
           o.commission_rate::float AS commission_rate,
           sup.name AS supplier_name
    FROM orders o
    LEFT JOIN suppliers sup ON sup.id = o.supplier_id
    WHERE o.id = ${id} LIMIT 1
    FOR UPDATE OF o
  `)[0] as OrderRow | undefined;
  if (!before) throw new HandoffRefused({ kind: 'notFound' });
  // Owner or manager: the hand-off writes the same fields PATCH does (warehouse,
  // payment, commission), so it takes PATCH's rule rather than /advance's
  // any-purchaser one — and only the owner can attach the chat screenshot the
  // self-paid rule asks for anyway.
  if (actor.role !== 'manager' && before.user_id !== actor.id) {
    throw new HandoffRefused({ kind: 'forbidden' });
  }
  if (before.archived_at) throw new HandoffRefused({ kind: 'archived' });
  if (before.lifecycle !== 'draft') {
    throw new HandoffRefused({ kind: 'notDraft', lifecycle: before.lifecycle });
  }

  const handoffBy = input.handoff.method === 'pickup' ? input.handoff.byUserId : null;
  const setCommission = input.commissionRate !== undefined;
  await tx`
    UPDATE orders SET
      warehouse_id    = ${input.warehouseId},
      source          = ${input.source},
      handoff_method  = ${input.handoff.method},
      handoff_by      = ${handoffBy},
      payment         = ${input.payment},
      payment_method  = ${input.paymentMethod},
      paypal_txn_id   = ${input.paypalTxnId},
      commission_rate = CASE WHEN ${setCommission}::int = 1 THEN ${input.commissionRate ?? null} ELSE commission_rate END
    WHERE id = ${id}
  `;
  const after = (await tx`
    SELECT warehouse_id, source, handoff_method, handoff_by, payment, payment_method,
           paypal_txn_id, commission_rate::float AS commission_rate
    FROM orders WHERE id = ${id}
  `)[0] as Record<string, unknown>;
  const changes = diff(before as unknown as Record<string, unknown>, after, HANDOFF_FIELDS);
  // The timeline names people, not uuids: handoff_by is logged as names, the
  // way owner_changed does it.
  const byChange = changes.find(ch => ch.field === 'handoff_by');
  if (byChange) {
    const ids = [byChange.from, byChange.to].filter((v): v is string => typeof v === 'string');
    const names = ids.length
      ? await tx<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE id = ANY(${ids}::uuid[])`
      : [];
    const nameOf = (v: unknown) => names.find(n => n.id === v)?.name ?? v;
    byChange.from = nameOf(byChange.from);
    byChange.to = nameOf(byChange.to);
  }
  if (changes.length) {
    await writeOrderEvent(tx, id, actor.id, 'meta_changed', { changes });
  }
  // Same reasoning as PATCH: the id names a payment that has very likely
  // already synced, so link it now rather than waiting for the six-hour pass.
  let paymentsLinked = 0;
  if (input.paypalTxnId) {
    paymentsLinked = await linkPaypalTxnToOrder(tx, input.paypalTxnId, id, actor.id);
  }

  if (input.newOwner && input.newOwner.ownerId !== before.user_id) {
    const prev = (await tx`
      SELECT name FROM users WHERE id = ${before.user_id} LIMIT 1
    `)[0] as { name: string } | undefined;
    await tx`UPDATE orders SET user_id = ${input.newOwner.ownerId} WHERE id = ${id}`;
    await writeOrderEvent(tx, id, actor.id, 'owner_changed', {
      fromUserId: before.user_id,
      from: prev?.name ?? null,
      toUserId: input.newOwner.ownerId,
      to: input.newOwner.ownerName ?? actor.name,
    });
  }

  let pkg: HandoffPackage | null = null;
  if (input.handoff.method === 'label') {
    // Same insert as POST /api/packages, already linked. ON CONFLICT rather
    // than a pre-check so two concurrent pastes of one number can't both pass.
    const inserted = (await tx`
      INSERT INTO packages (
        tracking_number, carrier, seller_name, source,
        paypal_txn_id, payment_screenshot_key, payment_screenshot_url, order_id, created_by
      )
      VALUES (
        ${input.handoff.trackingNumber}, ${input.handoff.carrier}, ${before.supplier_name},
        ${input.source}, ${input.paypalTxnId}, ${input.paymentScreenshotKey},
        ${input.paymentScreenshotUrl}, ${id}, ${actor.id}
      )
      ON CONFLICT (tracking_number) DO NOTHING
      RETURNING id, tracking_number, carrier
    `) as unknown as HandoffPackage[];
    if (!inserted.length) throw new HandoffRefused({ kind: 'trackingTaken' });
    pkg = inserted[0];
  }

  await writeOrderEvent(tx, id, actor.id, 'handoff', {
    method: input.handoff.method,
    ...(input.handoff.method === 'pickup'
      ? { byUserId: input.handoff.byUserId, byName: input.handoff.byName }
      : { packageId: pkg!.id, trackingNumber: pkg!.tracking_number, carrier: pkg!.carrier }),
  });

  const outcome = await advanceOrderTx(tx, id, actor);
  if (outcome.kind !== 'ok') throw new HandoffRefused({ kind: 'advance', outcome });
  return { package: pkg, paymentsLinked };
}
