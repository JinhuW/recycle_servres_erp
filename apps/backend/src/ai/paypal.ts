// PayPal payment-screenshot OCR for the add-package flow. Unlike the receipt
// rename (best-effort side effect), this feeds a visible form field, so it
// keeps the label-scan contract: stub provider when no key (the UI shows its
// canned-data banner), throw on a failed real call (the route answers 502 and
// the user retries the shot).
import type { Env } from '../types';
import type { OcrProvider } from './types';
import { pickProvider } from './index';
import { openRouterImageJson } from './openrouter';
import { ocrCallsTotal } from '../metrics';

const PAYPAL_TXN_PROMPT = `You are reading a PayPal payment confirmation or activity screenshot. Find the PayPal transaction ID: a 17-character code of uppercase letters and digits (e.g. 8XY12345AB678901C), usually labeled "Transaction ID". Do NOT return an Invoice ID, Order ID, receipt number, or shipping tracking number. Respond with a single minified JSON object and nothing else — no markdown, no code fences, no prose:
{"txnId":"8XY12345AB678901C","confidence":0.95}
CONFIDENCE — your own 0..1 estimate that the value is the transaction ID read correctly.
If no transaction ID is visible, respond {"txnId":null,"confidence":0}.`;

// Canonical PayPal ids are exactly 17 chars; older/edge formats vary, so the
// gate is soft bounds and the strict shape only downgrades confidence.
export const PAYPAL_TXN_STRICT = /^[A-Z0-9]{17}$/;
const PAYPAL_TXN_LOOSE = /^[A-Z0-9]{10,32}$/;

// Backstop for model non-compliance: whatever comes back, only a plausible
// id shape reaches the form. Shared with the packages route boundary.
export function normalizePaypalTxnId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, '').toUpperCase();
  return PAYPAL_TXN_LOOSE.test(cleaned) ? cleaned : null;
}

export type PaypalTxnScan = {
  txnId: string | null;
  confidence: number;
  provider: OcrProvider;
};

export async function extractPaypalTxn(env: Env, imageBytes: ArrayBuffer): Promise<PaypalTxnScan> {
  const provider = pickProvider(env);
  if (provider === 'stub') {
    ocrCallsTotal.inc({ provider, outcome: 'stub' });
    return { txnId: '7AB12345CD678901E', confidence: 0.9, provider };
  }
  let json: Record<string, unknown>;
  try {
    json = await openRouterImageJson(env, PAYPAL_TXN_PROMPT, imageBytes);
    ocrCallsTotal.inc({ provider, outcome: 'ok' });
  } catch (e) {
    ocrCallsTotal.inc({ provider, outcome: 'error' });
    throw e;
  }
  const txnId = normalizePaypalTxnId(json.txnId);
  const self = typeof json.confidence === 'number' ? Math.min(Math.max(json.confidence, 0), 1) : 0.45;
  // A value outside the canonical 17-char shape may still be right, but the
  // user has to eyeball it — cap confidence under the UI's verify threshold.
  const confidence = txnId === null ? 0 : PAYPAL_TXN_STRICT.test(txnId) ? self : Math.min(self, 0.5);
  return { txnId, confidence, provider };
}
