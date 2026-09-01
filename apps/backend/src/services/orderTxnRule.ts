// "A company-paid PO must carry a payment transaction id before it can leave
// Draft." One implementation, two readers: the advance guard enforces it, and
// GET /api/orders/:id reports it as `txnRequired` so both shells can refuse
// before the round-trip. Split out because a second copy of the predicate is
// how the client ends up blocking an order the server would have let through.

import { getWorkspaceSetting } from '../lib/settings';
import type { SqlLike } from './orderAudit';

// Stamped as NOW() by migration 0115, so every environment grandfathers the
// orders it already had when the rule reached it. An absent key means the rule
// is off — a workspace that somehow lost the row fails open, never closed.
const CUTOFF_KEY = 'po_company_txn_required_from';

export type TxnRuleOrder = {
  payment: string;
  created_at: Date;
};

/** Whether the transaction-id rule governs this order at all. */
export async function txnRequiredFor(tx: SqlLike, order: TxnRuleOrder): Promise<boolean> {
  if (order.payment !== 'company') return false;
  const cutoff = await getWorkspaceSetting<string | null>(tx, CUTOFF_KEY, null);
  return cutoff !== null && order.created_at >= new Date(cutoff);
}

/** Whether this order is governed by the rule AND still fails it. */
export async function companyPayTxnMissing(
  tx: SqlLike,
  order: TxnRuleOrder & { paypal_txn_id: string | null },
): Promise<boolean> {
  // Cheapest test first: the cutoff lookup only runs for an order that would
  // actually be blocked by it, so the common advance costs no extra query.
  if (order.payment !== 'company') return false;
  if ((order.paypal_txn_id ?? '').trim() !== '') return false;
  return txnRequiredFor(tx, order);
}
