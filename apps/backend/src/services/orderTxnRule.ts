// What a PO must carry before it can leave Draft. One implementation, two
// readers: the advance guard enforces it, and GET /api/orders/:id reports the
// full list as `blockers` (and the older `txnRequired` / `chatShotRequired` /
// `cashShotRequired` flags) so both shells can refuse before the round-trip.
// Split out because a second copy of a predicate is how the client ends up
// blocking an order the server would have let through.
//
// Two kinds of blocker live here. The *facts* — where the goods came from,
// how they travel, who collected them or which box carries them, how the
// company paid — are the hand-off's to collect, so only the hand-off refuses
// on them (`leaveDraftBlockers` + `ENFORCED_EVERYWHERE`). The *proof* rules
// below are held against every door, a manager stage-jump included.
//
// Three rules, by who paid and how:
//   company card — the PayPal transaction id, unless the seller was paid in
//                  cash (payment_method 'cash'). NULL method is the historical
//                  row that was never asked: still required. And the id must
//                  be one the PayPal sync has seen in our account — once any
//                  PayPal account has synced into this environment. Until
//                  then (a dev box, the test suite) the synced table says
//                  nothing about the world and the rule stays off, in the
//                  same fail-open spirit as an absent cutoff key.
//   company cash — a screenshot of the amount handed over, as a Payment
//                  attachment. Its own bucket, not Submission: a receipt or a
//                  lot manifest left there is not proof of what was paid.
//   self-paid    — the chat with the seller, as a Submission attachment. No
//                  transaction id: a self-paid order is reimbursed from
//                  commission, not matched against the bank.

import { getWorkspaceSetting } from '../lib/settings';
import { wasEverSubmitted } from './orderAudit';
import type { SqlLike } from './orderAudit';

// Stamped as NOW() by migrations 0115 / 0126 / 0128, so every environment
// grandfathers the orders it already had when each rule reached it. An absent
// key means the rule is off — a workspace that somehow lost the row fails
// open, never closed.
const TXN_CUTOFF_KEY = 'po_company_txn_required_from';
const CHAT_CUTOFF_KEY = 'po_self_pay_chat_required_from';
const CASH_CUTOFF_KEY = 'po_cash_shot_required_from';

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
async function companyPayTxnMissing(
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
async function selfPayChatMissing(
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

export type CashRuleOrder = { payment: string; payment_method: string | null; created_at: Date };

/** Whether the cash-screenshot rule governs this order at all. */
export async function cashShotRequiredFor(tx: SqlLike, order: CashRuleOrder): Promise<boolean> {
  if (order.payment !== 'company' || order.payment_method !== 'cash') return false;
  return afterCutoff(tx, CASH_CUTOFF_KEY, order.created_at);
}

/** Whether this order is governed by the cash rule AND still fails it. */
async function companyCashShotMissing(
  tx: SqlLike,
  order: CashRuleOrder & { id: string },
): Promise<boolean> {
  if (order.payment !== 'company' || order.payment_method !== 'cash') return false;
  if (!await afterCutoff(tx, CASH_CUTOFF_KEY, order.created_at)) return false;
  const rows = await tx`
    SELECT 1 FROM order_status_attachments
    WHERE order_id = ${order.id} AND status = 'Payment' LIMIT 1
  `;
  return rows.length === 0;
}

export type LeaveDraftBlocker =
  | { kind: 'noCost' }
  | { kind: 'missingWarehouse' }
  | { kind: 'missingSource' }
  | { kind: 'missingDelivery' }
  | { kind: 'missingTracking' }
  | { kind: 'missingMethod' }
  | { kind: 'missingTxnId' }
  | { kind: 'unknownTxnId'; paypalTxnId: string }
  | { kind: 'missingChatShot' }
  | { kind: 'missingCashShot' };

export type LeaveDraftOrder = TxnRuleOrder & {
  id: string;
  paypal_txn_id: string | null;
  total_cost: number | null;
  warehouse_id: string | null;
  source: string | null;
  handoff_method: string | null;
  handoff_by: string | null;
  has_package: boolean;
};

/** The blockers every door refuses on. The facts are the hand-off's to
 *  collect: `/advance` and a manager stage-jump ignore them, so a Draft from
 *  before the hand-off existed (NULL source, NULL method) is never stuck. The
 *  warehouse is not a hand-off question but where the stock lands, and nothing
 *  past Draft asks for it again — so it is held against every door. */
export const ENFORCED_EVERYWHERE: ReadonlySet<LeaveDraftBlocker['kind']> =
  new Set(['noCost', 'missingWarehouse', 'missingTxnId', 'unknownTxnId', 'missingChatShot', 'missingCashShot']);

/** Every reason this Draft cannot leave, in the order the page lists them.
 *  Local reads only — never calls PayPal; the routes pull once before the
 *  advance when the id is unknown, so GET can report this list freely.
 *
 *  `noCost` is per order, not per line — a $0 line inside a priced lot is
 *  legitimate — and fees don't count: freight on free goods is still a PO
 *  without a cost. No cutoff, unlike the proof rules: a cost can always be
 *  added to an old Draft. First submission only: a PO back in Draft after a
 *  purchaser's edit re-submits as it was accepted, and the manager's
 *  change-review is where that edit is judged. The history read only runs
 *  for a $0 Draft, so the common advance pays nothing for it. */
export async function leaveDraftBlockers(tx: SqlLike, o: LeaveDraftOrder): Promise<LeaveDraftBlocker[]> {
  const out: LeaveDraftBlocker[] = [];
  if (!(Number(o.total_cost) > 0) && !(await wasEverSubmitted(tx, o.id))) out.push({ kind: 'noCost' });
  if (o.warehouse_id === null) out.push({ kind: 'missingWarehouse' });
  if (o.source === null) out.push({ kind: 'missingSource' });
  if (o.handoff_method === null || (o.handoff_method === 'pickup' && o.handoff_by === null)) {
    out.push({ kind: 'missingDelivery' });
  }
  if (o.handoff_method === 'label' && !o.has_package) out.push({ kind: 'missingTracking' });
  if (o.payment === 'company' && o.payment_method === null) out.push({ kind: 'missingMethod' });
  if (await companyPayTxnMissing(tx, o)) out.push({ kind: 'missingTxnId' });
  if (await companyPayTxnUnknown(tx, o)) out.push({ kind: 'unknownTxnId', paypalTxnId: o.paypal_txn_id!.trim() });
  if (await selfPayChatMissing(tx, o)) out.push({ kind: 'missingChatShot' });
  if (await companyCashShotMissing(tx, o)) out.push({ kind: 'missingCashShot' });
  return out;
}
