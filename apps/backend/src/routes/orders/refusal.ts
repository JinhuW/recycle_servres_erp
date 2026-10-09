// Why a write on a PO was refused. Thrown from inside the write's transaction,
// so the rollback comes for free, and turned into a response once outside it.
// It replaces message strings like '__DONE_LOCKED__' matched with
// `includes()`. Those passed their payload (the offending line ids, the other
// order) through variables captured from the enclosing handler, and a refusal
// added in one place and forgotten in the other fell through as a 500.
import type { Context } from 'hono';
import type { User } from '../../types';
import {
  committedLinesBody, describeSellOrders, PACKAGE_DELIVERED_MSG, TRACKING_TAKEN_STANDALONE_MSG,
  trackingTakenMsg,
} from './shared';

export type Refusal =
  | { kind: 'orderGone' }
  | { kind: 'forbidden' }
  | { kind: 'photoCap'; cap: number }
  | { kind: 'archived' }
  | { kind: 'doneLocked' }
  | { kind: 'purchaserDone' }
  | { kind: 'revertCommitted'; lineIds: string[] }
  | { kind: 'revertTransfer'; lineIds: string[] }
  | { kind: 'orderWouldBeEmpty' }
  | { kind: 'trackingNeedsLabel' }
  | { kind: 'trackingTaken'; otherOrderId: string | null }
  | { kind: 'trackingTakenStandalone' }
  | { kind: 'packageDelivered' }
  | { kind: 'qtyBelowCommitted'; lineIds: string[]; sellOrderIds: string[] }
  | { kind: 'removeReferenced'; lineIds: string[]; sellOrderIds: string[] };

export class OrderRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(`order refusal: ${refusal.kind}`);
    this.name = 'OrderRefusal';
  }
}

export function refusalResponse(c: Context, u: User, r: Refusal): Response {
  switch (r.kind) {
    case 'orderGone':
      return c.json({ error: 'Not found' }, 404);
    case 'forbidden':
      return c.json({ error: 'Forbidden' }, 403);
    case 'photoCap':
      return c.json({ error: `at most ${r.cap} photos per product` }, 409);
    case 'doneLocked':
      return c.json({ error: 'Order is Ready to Pay or Done and cannot be modified. Move it back to Reviewing first.' }, 409);
    case 'archived':
      return c.json({ error: 'Order is archived — unarchive it first' }, 409);
    case 'purchaserDone':
      return c.json({ error: 'Only managers can edit an order after submission' }, 403);
    // The revert is a purchaser's edit, so there is no manager variant of
    // these two: the lines that block, and no sell order named.
    case 'revertCommitted':
      return c.json({
        error: 'Products in this order are on open sell orders — a manager has to make this change.',
        offendingLineIds: r.lineIds,
      }, 409);
    case 'revertTransfer':
      return c.json({
        error: 'Products in this order are out on an open transfer order. Receive or discard that transfer before editing it.',
        offendingLineIds: r.lineIds,
      }, 409);
    case 'orderWouldBeEmpty':
      return c.json({ error: 'An order must keep at least one product. Delete the order instead.' }, 409);
    case 'trackingNeedsLabel':
      return c.json({ error: 'A tracking number belongs to a shipping label — set handoffMethod to label' }, 400);
    case 'trackingTaken':
      return c.json({ error: trackingTakenMsg(r.otherOrderId), otherOrderId: r.otherOrderId }, 409);
    case 'trackingTakenStandalone':
      return c.json({ error: TRACKING_TAKEN_STANDALONE_MSG }, 409);
    case 'packageDelivered':
      return c.json({ error: PACKAGE_DELIVERED_MSG }, 409);
    case 'qtyBelowCommitted':
      return c.json(committedLinesBody(u, r.lineIds, r.sellOrderIds,
        `A product's new qty is below what ${describeSellOrders(r.sellOrderIds)} already holds. Lower or close that sell order first.`,
        'A product\'s new qty is below what an open sell order holds — a manager has to change it.'), 409);
    case 'removeReferenced':
      return c.json(committedLinesBody(u, r.lineIds, r.sellOrderIds,
        `A product you tried to remove is on ${describeSellOrders(r.sellOrderIds)} and cannot be deleted. Archive or cancel those sell orders first.`,
        'A product you tried to remove is on an open sell order — a manager has to remove it.'), 409);
  }
}
