// The proof a PO must carry before it can leave Draft. One implementation,
// two readers each: the advance guard enforces it, and GET /api/orders/:id
// reports it as `txnRequired` / `chatShotRequired` so both shells can refuse
// before the round-trip. Split out because a second copy of a predicate is
// how the client ends up blocking an order the server would have let through.
//
// Two rules, by who paid:
//   company card — the PayPal transaction id, unless the seller was paid in
//                  cash (payment_method 'cash'). NULL method is the historical
//                  row that was never asked: still required. And the id must
//                  be one the PayPal sync has seen in our account — once any
//                  PayPal account has synced into this environment. Until
//                  then (a dev box, the test suite) the synced table says
//                  nothing about the world and the rule stays off, in the
//                  same fail-open spirit as an absent cutoff key.
//   self-paid    — the chat with the seller, as a Submission attachment. No
//                  transaction id: a self-paid order is reimbursed from
//                  commission, not matched against the bank.

import { getWorkspaceSetting } from '../lib/settings';
import type { SqlLike } from './orderAudit';

// Stamped as NOW() by migrations 0115 / 0126, so every environment
// grandfathers the orders it already had when each rule reached it. An absent
// key means the rule is off — a workspace that somehow lost the row fails
// open, never closed.
const TXN_CUTOFF_KEY = 'po_company_txn_required_from';
const CHAT_CUTOFF_KEY = 'po_self_pay_chat_required_from';

export type TxnRuleOrder = {
  payment: string;
  payment_method: string | null;
  created_at: Date;
};

async function afterCutoff(tx: SqlLike, key: string, createdAt: Date): Promise<boolean> {
  const cutoff = await getWorkspaceSetting<string | null>(tx, key, null);
  return cutoff !== null && createdAt >= new Date(cutoff);
}

/** Whether the transaction-id rule governs this order at all. */
export async function txnRequiredFor(tx: SqlLike, order: TxnRuleOrder): Promise<boolean> {
  if (order.payment !== 'company' || order.payment_method === 'cash') return false;
  return afterCutoff(tx, TXN_CUTOFF_KEY, order.created_at);
}

/** Whether this order is governed by the rule AND still fails it. */
export async function companyPayTxnMissing(
  tx: SqlLike,
  order: TxnRuleOrder & { paypal_txn_id: string | null },
): Promise<boolean> {
  // Cheapest test first: the cutoff lookup only runs for an order that would
  // actually be blocked by it, so the common advance costs no extra query.
  if (order.payment !== 'company' || order.payment_method === 'cash') return false;
  if ((order.paypal_txn_id ?? '').trim() !== '') return false;
  return afterCutoff(tx, TXN_CUTOFF_KEY, order.created_at);
}

/** Whether this order is governed by the rule, names an id, and that id is
 *  not among the PayPal transactions synced from our account. Any PayPal row
 *  counts — linked elsewhere, ignored, pending or reversed — because the
 *  question is whether the payment exists, not whether it is free; Mercury
 *  legs carrying a parsed id do not, because they are not our PayPal account.
 *  Off until a PayPal account has synced: an empty table proves nothing. */
export async function companyPayTxnUnknown(
  tx: SqlLike,
  order: TxnRuleOrder & { paypal_txn_id: string | null },
): Promise<boolean> {
  if (order.payment !== 'company' || order.payment_method === 'cash') return false;
  const id = (order.paypal_txn_id ?? '').trim();
  if (id === '') return false;
  if (!await afterCutoff(tx, TXN_CUTOFF_KEY, order.created_at)) return false;
  const synced = await tx`SELECT 1 FROM bank_accounts WHERE source = 'paypal' LIMIT 1`;
  if (synced.length === 0) return false;
  const hit = await tx`
    SELECT 1 FROM bank_transactions
    WHERE source = 'paypal' AND UPPER(paypal_txn_id) = UPPER(${id}) LIMIT 1`;
  return hit.length === 0;
}

export type ChatRuleOrder = { payment: string; created_at: Date };

/** Whether the chat-history rule governs this order at all. */
export async function chatShotRequiredFor(tx: SqlLike, order: ChatRuleOrder): Promise<boolean> {
  if (order.payment !== 'self') return false;
  return afterCutoff(tx, CHAT_CUTOFF_KEY, order.created_at);
}

/** Whether this order is governed by the chat rule AND still fails it. Any
 *  Submission attachment satisfies it: that status has no finer purpose, and
 *  a receipt left there is still the purchaser's evidence for the deal. */
export async function selfPayChatMissing(
  tx: SqlLike,
  order: ChatRuleOrder & { id: string },
): Promise<boolean> {
  if (order.payment !== 'self') return false;
  if (!await afterCutoff(tx, CHAT_CUTOFF_KEY, order.created_at)) return false;
  const rows = await tx`
    SELECT 1 FROM order_status_attachments
    WHERE order_id = ${order.id} AND status = 'Submission' LIMIT 1
  `;
  return rows.length === 0;
}
