// Carrier detection from tracking-number shape, for the add-label form.
// Format rules only — no checksum validation; ambiguous shapes return every
// plausible carrier and the form lets the user pick.

export type Carrier = 'UPS' | 'FedEx' | 'USPS';

export const CARRIERS: Carrier[] = ['UPS', 'FedEx', 'USPS'];

export function normalizeTracking(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

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
