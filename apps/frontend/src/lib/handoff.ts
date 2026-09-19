// The hand-off dialog's rules, kept pure so both shells and the test share one
// answer to "what still stands between this order and In Transit". Mirrors
// POST /api/orders/:id/handoff — the server's 409 is the real gate; these save
// the round-trip and name the fix inline.

import type { Carrier } from './carrierDetect';
import type { PackageSource } from './packageSource';

export type HandoffDelivery = 'pickup' | 'label';
export type HandoffMethod = 'paypal' | 'cash';

export type HandoffRules = {
  source: PackageSource | null;
  delivery: HandoffDelivery | null;
  trackingValid: boolean;
  carrier: Carrier | null;
  paidBy: 'company' | 'self';
  /** Null is a company order that was never asked — the dialog asks. */
  method: HandoffMethod | null;
  txnId: string;
  chatAttachmentCount: number;
  /** Payment-bucket attachments: the cash screenshot(s). */
  proofAttachmentCount: number;
  /** What the server said about the *saved* order. Each verdict was computed
   *  for the saved paid-by and method — `txnRequired` on the company /
   *  not-cash branch (a never-asked null method included), `cashShotRequired`
   *  on company / cash — so an explicit `false` only exempts while the dialog
   *  is still on that branch (a pre-cutoff order keeps its exemption). A flip
   *  of either, or anything else, blocks and lets the server be the judge. */
  saved: {
    payment: 'company' | 'self';
    paymentMethod?: HandoffMethod | null;
    txnRequired?: boolean;
    chatShotRequired?: boolean;
    cashShotRequired?: boolean;
  };
};

/** i18n keys of everything still blocking the hand-off, in display order. */
export function handoffBlockerKeys(r: HandoffRules): string[] {
  const out: string[] = [];
  if (!r.source) out.push('hoNeedSource');
  if (r.delivery === null) out.push('hoNeedDelivery');
  if (r.delivery === 'label') {
    if (!r.trackingValid) out.push('hoNeedTracking');
    else if (!r.carrier) out.push('hoNeedCarrier');
  }
  if (r.paidBy === 'company' && r.method === null) out.push('hoNeedMethod');
  if (r.paidBy === 'company' && r.method === 'paypal' && !r.txnId.trim()) {
    const exempt = r.saved.payment === 'company' && r.saved.paymentMethod !== 'cash'
      && r.saved.txnRequired === false;
    if (!exempt) out.push('poTxnRequired');
  }
  if (r.paidBy === 'company' && r.method === 'cash' && r.proofAttachmentCount === 0) {
    const exempt = r.saved.payment === 'company' && r.saved.paymentMethod === 'cash'
      && r.saved.cashShotRequired === false;
    if (!exempt) out.push('hoNeedCashShot');
  }
  if (r.paidBy === 'self' && r.chatAttachmentCount === 0) {
    const exempt = r.saved.payment === 'self' && r.saved.chatShotRequired === false;
    if (!exempt) out.push('hoNeedChatShot');
  }
  return out;
}

export type HandoffBody = {
  warehouseId: string;
  source: PackageSource;
  handoff:
    | { method: 'pickup'; byUserId: string }
    | { method: 'label'; trackingNumber: string; carrier: Carrier };
  payment: 'company' | 'self';
  paymentMethod?: HandoffMethod;
  paypalTxnId?: string;
  paymentScreenshotKey?: string;
  paymentScreenshotUrl?: string;
  onBehalfOfUserId?: string;
  commissionRate?: number | null;
};

export type HandoffDraft = {
  warehouseId: string;
  source: PackageSource;
  delivery: HandoffDelivery;
  byUserId: string;
  trackingNumber: string;
  carrier: Carrier | null;
  paidBy: 'company' | 'self';
  /** Non-null for a company order by the time submit is allowed (blocker). */
  method: HandoffMethod | null;
  txnId: string;
  screenshot: { key: string; url: string } | null;
  /** Manager-only; undefined leaves the owner / rate untouched. */
  ownerId?: string;
  commissionRate?: number | null;
};

/** The request body, shaped so a self-paid order sends no method and no
 *  transaction id, and a pickup sends no tracking. */
export function buildHandoffBody(d: HandoffDraft): HandoffBody {
  const body: HandoffBody = {
    warehouseId: d.warehouseId,
    source: d.source,
    handoff: d.delivery === 'pickup'
      ? { method: 'pickup', byUserId: d.byUserId }
      : { method: 'label', trackingNumber: d.trackingNumber, carrier: d.carrier as Carrier },
    payment: d.paidBy,
  };
  if (d.paidBy === 'company' && d.method) {
    body.paymentMethod = d.method;
    if (d.method === 'paypal') {
      if (d.txnId.trim()) body.paypalTxnId = d.txnId.trim();
      if (d.screenshot) {
        body.paymentScreenshotKey = d.screenshot.key;
        body.paymentScreenshotUrl = d.screenshot.url;
      }
    }
  }
  if (d.ownerId !== undefined) body.onBehalfOfUserId = d.ownerId;
  if (d.commissionRate !== undefined) body.commissionRate = d.commissionRate;
  return body;
}
