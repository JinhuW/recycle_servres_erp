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
