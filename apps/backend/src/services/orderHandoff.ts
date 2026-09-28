// The Draft → In Transit hand-off, as one transaction: the checkpoint's fields
// are written to the order, a pasted tracking number becomes a package linked
// to it, and the advance runs through the same guards as POST /advance. Any
// refusal rolls the whole thing back — three separate calls left a package
// linked to a Draft that then failed the proof rule, and a purchaser holding a
// half-written order to re-present.
//
// Every input is optional: the checkpoint asks only for what the order does
// not already hold, so what it omits is read off the row under the same lock.
// The advance then judges the merged row with every blocker enforced — this
// is the door that collects the facts, so it is the one that may refuse for
// want of them.
//
// Validation of the request body is the route's job (it runs on the pool
// before the transaction, like PATCH); this file trusts its input.

import type { Carrier, PackageSource } from '@recycle-erp/shared';
import { linkPaypalTxnToOrder } from '../banktx/sync';
import { advanceOrderTx, type AdvanceActor, type AdvanceOutcome } from './orderAdvance';
import { diff, writeOrderEvent, type AuditChange, type SqlLike } from './orderAudit';

export type HandoffInput = {
  warehouseId?: string;
  source?: PackageSource;
  handoff?:
    | { method: 'pickup'; byUserId?: string }
    | { method: 'label'; trackingNumber?: string; carrier?: Carrier };
  payment?: 'company' | 'self';
  /** Company card only; a self-paid order carries none. */
  paymentMethod?: 'paypal' | 'cash' | null;
  /** Already normalised (no whitespace, upper-case) by the route. */
  paypalTxnId?: string | null;
  paymentScreenshotKey?: string | null;
  paymentScreenshotUrl?: string | null;
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
  | { kind: 'trackingTaken'; otherOrderId: string | null }
  | { kind: 'trackingTakenStandalone' }
  | { kind: 'packageDelivered' }
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

/** The timeline names people, not uuids: a handoff_by change is rewritten
 *  with names the way owner_changed does it. Shared with PATCH. */
export async function nameHandoffByChange(tx: SqlLike, changes: AuditChange[]): Promise<void> {
  const byChange = changes.find(ch => ch.field === 'handoff_by');
  if (!byChange) return;
  const ids = [byChange.from, byChange.to].filter((v): v is string => typeof v === 'string');
  const names = ids.length
    ? await tx<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE id = ANY(${ids}::uuid[])`
    : [];
  const nameOf = (v: unknown) => names.find(n => n.id === v)?.name ?? v;
  byChange.from = nameOf(byChange.from);
  byChange.to = nameOf(byChange.to);
}

export type PackageSet =
  | { kind: 'ok'; package: HandoffPackage; prev: HandoffPackage | null; needsRegister: boolean }
  | { kind: 'taken'; packageId: string; otherOrderId: string | null }
  /** The number sits on a standalone box another member is tracking. */
  | { kind: 'takenStandalone'; packageId: string }
  /** The order's box has already arrived; its record is history now. */
  | { kind: 'delivered' };

export type PackageOrderFacts = {
  user_id: string;
  source: string | null;
  supplier_name: string | null;
  paypal_txn_id: string | null;
  payment_screenshot_key?: string | null;
  payment_screenshot_url?: string | null;
};

export type PackageActor = { id: string; role: string };

// A standalone box is somebody's: the person who pasted it on the Shipping
// page. Only they, the PO's owner, or a manager may pull it onto a PO — a
// purchaser typing a number they saw must not walk off with another member's
// box and the seller / payment facts on it. A creator-less row (older data)
// is nobody's to protect.
function mayAdopt(actor: PackageActor, ownerId: string, createdBy: string | null): boolean {
  return actor.role === 'manager' || createdBy === null || createdBy === actor.id || createdBy === ownerId;
}

/** The box the order's tracking number names, made so. Newest linked package
 *  first (FOR UPDATE): the same number is a no-op; a different number updates
 *  it in place with its tracking columns reset, so a typo fix leaves no
 *  phantom row on the Shipping page; a number already on a standalone package
 *  adopts that row (unlinking the old one) so label → pickup → label on one
 *  PO cannot dead-end; a number on another PO is `taken`; no package yet →
 *  the insert the hand-off always made. Adoption keeps the caller's carrier —
 *  the person typing the number is looking at the label — and a carrier
 *  change is a fresh registration, as it is on the same-row branch.
 *  Re-registration is the caller's: Shippo has no unregister, and a push for
 *  the old number simply matches no row and is dropped.
 *
 *  A box the carrier already marked delivered is never rewritten: resetting it
 *  to `purchased` destroys the delivery record, and (via unlink) a delivered
 *  standalone box re-enters the Shipping page's "Needs you" with a Create PO
 *  button that mints a second PO for goods this one already received. */
export async function setOrderPackageTx(
  tx: SqlLike,
  orderId: string,
  actor: PackageActor,
  order: PackageOrderFacts,
  want: { trackingNumber: string; carrier: Carrier },
): Promise<PackageSet> {
  const curRow = (await tx`
    SELECT id, tracking_number, carrier, status FROM packages
    WHERE order_id = ${orderId}
    ORDER BY created_at DESC, id DESC LIMIT 1
    FOR UPDATE
  `)[0] as (HandoffPackage & { status: string }) | undefined;
  const cur: HandoffPackage | undefined = curRow
    && { id: curRow.id, tracking_number: curRow.tracking_number, carrier: curRow.carrier };
  if (cur && cur.tracking_number === want.trackingNumber) {
    if (cur.carrier === want.carrier) return { kind: 'ok', package: cur, prev: cur, needsRegister: false };
    await tx`UPDATE packages SET carrier = ${want.carrier}, tracking_registered_at = NULL WHERE id = ${cur.id}`;
    return { kind: 'ok', package: { ...cur, carrier: want.carrier }, prev: cur, needsRegister: true };
  }
  if (curRow?.status === 'delivered') return { kind: 'delivered' };

  const other = (await tx`
    SELECT id, order_id, carrier, created_by, tracking_registered_at FROM packages
    WHERE tracking_number = ${want.trackingNumber} AND id IS DISTINCT FROM ${cur?.id ?? null}
    LIMIT 1 FOR UPDATE
  `)[0] as {
    id: string; order_id: string | null; carrier: string; created_by: string | null;
    tracking_registered_at: Date | null;
  } | undefined;
  if (other) {
    if (other.order_id !== null) return { kind: 'taken', packageId: other.id, otherOrderId: other.order_id };
    if (!mayAdopt(actor, order.user_id, other.created_by)) return { kind: 'takenStandalone', packageId: other.id };
    const needsRegister = other.tracking_registered_at === null || other.carrier !== want.carrier;
    await tx`
      UPDATE packages SET order_id = ${orderId}, carrier = ${want.carrier},
                          source = COALESCE(source, ${order.source}),
                          tracking_registered_at = CASE WHEN ${needsRegister}::boolean THEN NULL ELSE tracking_registered_at END
      WHERE id = ${other.id}
    `;
    if (cur) await tx`UPDATE packages SET order_id = NULL WHERE id = ${cur.id}`;
    return {
      kind: 'ok',
      package: { id: other.id, tracking_number: want.trackingNumber, carrier: want.carrier },
      prev: cur ?? null,
      needsRegister,
    };
  }

  if (cur) {
    // In place, so a typo fix leaves no phantom row. A concurrent paste of the
    // same number between the SELECT above and this UPDATE is the one race
    // left; it surfaces as the unique-index error, never as a duplicate box.
    await tx`
      UPDATE packages SET
        tracking_number = ${want.trackingNumber}, carrier = ${want.carrier},
        status = 'purchased', tracking_status = NULL, tracking_eta = NULL,
        last_tracked_at = NULL, tracking_registered_at = NULL
      WHERE id = ${cur.id}
    `;
    return {
      kind: 'ok',
      package: { id: cur.id, tracking_number: want.trackingNumber, carrier: want.carrier },
      prev: cur,
      needsRegister: true,
    };
  }
  // Same insert as POST /api/packages, already linked. ON CONFLICT rather
  // than trusting the SELECT above: two concurrent pastes of one number
  // can't both pass, and a unique-index error would abort the caller's tx.
  const inserted = (await tx`
    INSERT INTO packages (
      tracking_number, carrier, seller_name, source,
      paypal_txn_id, payment_screenshot_key, payment_screenshot_url, order_id, created_by
    )
    VALUES (
      ${want.trackingNumber}, ${want.carrier}, ${order.supplier_name}, ${order.source},
      ${order.paypal_txn_id}, ${order.payment_screenshot_key ?? null},
      ${order.payment_screenshot_url ?? null}, ${orderId}, ${actor.id}
    )
    ON CONFLICT (tracking_number) DO NOTHING
    RETURNING id, tracking_number, carrier
  `) as unknown as HandoffPackage[];
  if (!inserted.length) {
    const winner = (await tx`
      SELECT id, order_id FROM packages WHERE tracking_number = ${want.trackingNumber} LIMIT 1
    `)[0] as { id: string; order_id: string | null } | undefined;
    return { kind: 'taken', packageId: winner?.id ?? '', otherOrderId: winner?.order_id ?? null };
  }
  return { kind: 'ok', package: inserted[0], prev: null, needsRegister: true };
}

export type PackageUnlink =
  | { kind: 'ok'; gone: HandoffPackage[] }
  | { kind: 'delivered' };

/** Label → pickup: the box is no longer this order's. Unlinked, not deleted —
 *  migration 0094's own rule for the order's deletion, and DELETE /api/packages
 *  can still remove the row from the Shipping page if it is noise. Refused
 *  once the box has arrived: a delivered standalone row lands back in the
 *  Shipping page's "Needs you" bucket, whose Create PO mints a second PO for
 *  goods this order already received. */
export async function unlinkOrderPackagesTx(tx: SqlLike, orderId: string): Promise<PackageUnlink> {
  const delivered = await tx`
    SELECT 1 FROM packages WHERE order_id = ${orderId} AND status = 'delivered' LIMIT 1
  `;
  if (delivered.length) return { kind: 'delivered' };
  const gone = (await tx`
    UPDATE packages SET order_id = NULL WHERE order_id = ${orderId}
    RETURNING id, tracking_number, carrier
  `) as unknown as HandoffPackage[];
  return { kind: 'ok', gone };
}

/** The audit entries a package move produces, in META_FIELDS' shape. */
export function packageChanges(prev: HandoffPackage | null, next: HandoffPackage | null): AuditChange[] {
  const out: AuditChange[] = [];
  if ((prev?.tracking_number ?? null) !== (next?.tracking_number ?? null)) {
    out.push({ field: 'tracking_number', from: prev?.tracking_number ?? null, to: next?.tracking_number ?? null });
  }
  if ((prev?.carrier ?? null) !== (next?.carrier ?? null)) {
    out.push({ field: 'carrier', from: prev?.carrier ?? null, to: next?.carrier ?? null });
  }
  return out;
}

// Its own event kind rather than a meta diff: user_id isn't a META_FIELD (the
// timeline names people, not a uuid diff), and both names are snapshotted here
// because events render without joining users on the owner. A null ownerName
// is the actor taking the order back.
export async function changeOrderOwnerTx(
  tx: SqlLike,
  id: string,
  actor: { id: string; name: string },
  fromUserId: string,
  newOwner: { ownerId: string; ownerName: string | null },
): Promise<void> {
  const prev = (await tx`
    SELECT name FROM users WHERE id = ${fromUserId} LIMIT 1
  `)[0] as { name: string } | undefined;
  await tx`UPDATE orders SET user_id = ${newOwner.ownerId} WHERE id = ${id}`;
  await writeOrderEvent(tx, id, actor.id, 'owner_changed', {
    fromUserId,
    from: prev?.name ?? null,
    toUserId: newOwner.ownerId,
    to: newOwner.ownerName ?? actor.name,
  });
}

export async function handoffOrderTx(
  tx: SqlLike,
  id: string,
  actor: AdvanceActor,
  input: HandoffInput,
): Promise<{ package: HandoffPackage | null; needsRegister: boolean; paymentsLinked: number }> {
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

  // Body over row. A field the checkpoint did not ask for is the one the page
  // already holds.
  const warehouseId = input.warehouseId ?? before.warehouse_id;
  const source = input.source ?? before.source;
  const method = input.handoff?.method ?? before.handoff_method;
  // The row's collector was active when it was saved; it may not be any more.
  // A deactivated one is no collector, and the advance below says so.
  const wantedBy = method === 'pickup'
    ? (input.handoff?.method === 'pickup' && input.handoff.byUserId) || before.handoff_by
    : null;
  const collector = wantedBy ? await activeMember(tx, wantedBy) : null;
  const handoffBy = collector?.id ?? null;
  const payment = input.payment ?? before.payment;
  const paymentMethod = payment === 'self'
    ? null
    : (input.paymentMethod !== undefined ? input.paymentMethod : before.payment_method);
  // The id follows the method the way the method follows the payment: only a
  // PayPal payment has one. A Draft saved as PayPal and handed off as Self or
  // Cash must not keep the id — the link below would file a company payment
  // against a PO the company never paid for.
  const paypalTxnId = paymentMethod !== 'paypal'
    ? null
    : (input.paypalTxnId !== undefined ? input.paypalTxnId : before.paypal_txn_id);
  const setCommission = input.commissionRate !== undefined;
  await tx`
    UPDATE orders SET
      warehouse_id    = ${warehouseId},
      source          = ${source},
      handoff_method  = ${method},
      handoff_by      = ${handoffBy},
      payment         = ${payment},
      payment_method  = ${paymentMethod},
      paypal_txn_id   = ${paypalTxnId},
      commission_rate = CASE WHEN ${setCommission}::int = 1 THEN ${input.commissionRate ?? null} ELSE commission_rate END
    WHERE id = ${id}
  `;
  const after = (await tx`
    SELECT warehouse_id, source, handoff_method, handoff_by, payment, payment_method,
           paypal_txn_id, commission_rate::float AS commission_rate
    FROM orders WHERE id = ${id}
  `)[0] as Record<string, unknown>;
  const changes = diff(before as unknown as Record<string, unknown>, after, HANDOFF_FIELDS);
  await nameHandoffByChange(tx, changes);

  let pkg: HandoffPackage | null = null;
  let needsRegister = false;
  if (method === 'label') {
    const want = input.handoff?.method === 'label' && input.handoff.trackingNumber && input.handoff.carrier
      ? { trackingNumber: input.handoff.trackingNumber, carrier: input.handoff.carrier }
      : null;
    if (want) {
      const set = await setOrderPackageTx(tx, id, { id: actor.id, role: actor.role }, {
        user_id: before.user_id, source, supplier_name: before.supplier_name, paypal_txn_id: paypalTxnId,
        payment_screenshot_key: input.paymentScreenshotKey ?? null,
        payment_screenshot_url: input.paymentScreenshotUrl ?? null,
      }, want);
      if (set.kind === 'taken') {
        throw new HandoffRefused({ kind: 'trackingTaken', otherOrderId: set.otherOrderId });
      }
      if (set.kind === 'takenStandalone') throw new HandoffRefused({ kind: 'trackingTakenStandalone' });
      if (set.kind === 'delivered') throw new HandoffRefused({ kind: 'packageDelivered' });
      pkg = set.package;
      needsRegister = set.needsRegister;
      changes.push(...packageChanges(set.prev, set.package));
    } else {
      // The page's package, if it has one; the advance refuses when it hasn't.
      pkg = (await tx`
        SELECT id, tracking_number, carrier FROM packages
        WHERE order_id = ${id} ORDER BY created_at DESC, id DESC LIMIT 1
      `)[0] as HandoffPackage | undefined ?? null;
    }
  } else if (before.handoff_method === 'label') {
    const unlinked = await unlinkOrderPackagesTx(tx, id);
    if (unlinked.kind === 'delivered') throw new HandoffRefused({ kind: 'packageDelivered' });
    if (unlinked.gone.length) changes.push(...packageChanges(unlinked.gone[0], null));
  }

  if (changes.length) {
    await writeOrderEvent(tx, id, actor.id, 'meta_changed', { changes });
  }
  // Same reasoning as PATCH: the id names a payment that has very likely
  // already synced, so link it now rather than waiting for the six-hour pass.
  let paymentsLinked = 0;
  if (paypalTxnId) {
    paymentsLinked = await linkPaypalTxnToOrder(tx, paypalTxnId, id, actor.id);
  }

  if (input.newOwner && input.newOwner.ownerId !== before.user_id) {
    await changeOrderOwnerTx(tx, id, actor, before.user_id, input.newOwner);
  }

  // Written before the advance's `submitted` so the timeline reads "handed
  // off, then submitted". A label with no box, or a pickup with no collector,
  // writes nothing here: the advance below refuses it and unwinds the rest.
  if (method === 'pickup' && collector) {
    await writeOrderEvent(tx, id, actor.id, 'handoff', {
      method, byUserId: collector.id, byName: collector.name,
    });
  } else if (method === 'label' && pkg) {
    await writeOrderEvent(tx, id, actor.id, 'handoff', {
      method, packageId: pkg.id, trackingNumber: pkg.tracking_number, carrier: pkg.carrier,
    });
  }

  // The merged row is what gets judged, every blocker enforced — this is the
  // door that collects the facts, so it is the one that refuses for want of
  // them.
  const outcome = await advanceOrderTx(tx, id, actor, undefined, { enforce: 'all' });
  if (outcome.kind !== 'ok') throw new HandoffRefused({ kind: 'advance', outcome });
  return { package: pkg, needsRegister, paymentsLinked };
}
