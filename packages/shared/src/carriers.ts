// Carrier vocabulary and tracking-number shape rules for standalone tracked
// packages, shared by the frontend add-label forms and the backend
// /api/packages boundary so the two sides can never disagree on what counts
// as a carrier or as the same tracking number. (Migration 0094's CHECK
// necessarily mirrors CARRIERS — extend both together.)

export type Carrier = 'UPS' | 'FedEx' | 'USPS';

export const CARRIERS: Carrier[] = ['UPS', 'FedEx', 'USPS'];

export function normalizeTracking(raw: string): string {
  // \s misses the zero-width/bidi characters chat apps and Outlook wrap
  // pasted numbers in, and raw barcode decoders emit the GS1 FNC1 separator
  // as an ASCII GS control — any of these silently defeats the shape rules
  // below.
  return raw.replace(/[-\s\u0000-\u001F\u007F\u200B-\u200F\u2060\uFEFF]+/g, '').toUpperCase();
}

// Letters and digits only, inside the length band real carrier numbers occupy
// (UPS 18, FedEx/USPS up to 22 — 30 leaves headroom). Anything else — a LIKE
// metacharacter, a URL from a stray QR decode, a whole unwrapped ~34-digit
// FedEx-96 barcode — would be stored as a dead row the tracker can never
// resolve, shadowing the real number entered later.
export function isValidTracking(raw: string): boolean {
  return /^[A-Z0-9]{8,30}$/.test(normalizeTracking(raw));
}

// Label barcodes can wrap the tracking number in routing data. Only the USPS
// IMpb 420+ZIP prefix is stripped — it's unambiguous (the remainder must still
// scan as a USPS number). FedEx 96 barcodes are left whole on purpose: any
// 15-digit suffix of a digit run "detects" as FedEx, so extraction could
// silently prefill a wrong number. This feeds the add-package form only; the
// server-side lookup matches wrapped scans by suffix instead.
export function extractTrackingFromBarcode(raw: string): string {
  const tn = normalizeTracking(raw);
  const impb = /^420(?:\d{9}|\d{5})/.exec(tn);
  if (impb) {
    // Try the ZIP9 variant first — a ZIP5 strip of a ZIP9 barcode leaves
    // four routing digits glued to the front of the number.
    for (const cut of impb[0].length === 12 ? [12, 8] : [8]) {
      const rest = tn.slice(cut);
      if (detectCarriers(rest).includes('USPS')) return rest;
    }
  }
  return tn;
}

// Format rules only — no checksum validation; ambiguous shapes return every
// plausible carrier and the form lets the user pick.
export function detectCarriers(raw: string): Carrier[] {
  const tn = normalizeTracking(raw);
  if (/^1Z[A-Z0-9]{16}$/.test(tn)) return ['UPS'];
  if (/^[A-Z]{2}\d{9}US$/.test(tn)) return ['USPS'];
  if (/^\d{12}$/.test(tn) || /^\d{15}$/.test(tn)) return ['FedEx'];
  if (/^\d{20,22}$/.test(tn) && tn.startsWith('9')) {
    // FedEx Ground shares the 96-prefixed long-digit space with USPS.
    return tn.startsWith('96') ? ['FedEx', 'USPS'] : ['USPS'];
  }
  return [];
}
