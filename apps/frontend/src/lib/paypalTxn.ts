import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from './status';

// PayPal transaction-id canon, mirrored from the backend boundary
// (routes/packages.ts / ai/paypal.ts) so what the user sees in the input is
// exactly what the server stores and diffs.

export function normalizePaypalTxnInput(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

/** Canonical PayPal ids are exactly 17 chars A–Z/0–9; anything else is worth a second look. */
export function isStrictPaypalTxnId(s: string): boolean {
  return /^[A-Z0-9]{17}$/.test(s);
}

/** What a PayPal-screenshot scan is worth to the form: the id to fill (null
 *  when the read is too weak to offer) and the one-line notice to show for
 *  it. One rule for the cost payment and the commission payment, so the two
 *  cannot disagree about what "read it" means. */
export function readPaypalScan(r: { txnId: string | null; confidence: number; provider: string }): {
  txnId: string | null; noticeKey: string;
} {
  if (!r.txnId || r.confidence < AI_UNREADABLE_FLOOR) return { txnId: null, noticeKey: 'shipPayNoTxnFound' };
  return {
    txnId: normalizePaypalTxnInput(r.txnId),
    noticeKey: r.provider === 'stub' ? 'stubScanWarn'
      : r.confidence < AI_CONFIDENCE_FLOOR ? 'shipPayVerifyTxn' : 'hoShotRead',
  };
}
