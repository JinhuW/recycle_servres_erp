// The stored form of a Chip # marking.
//
// Upper-case for every brand: die codes are printed upper-case, and case noise
// from typing or OCR would fork one chip into two spellings.
//
// A Micron chip prints two lines — a date/lot code over the FBGA die code
// (`8KE75` / `D9VPP`) — and purchasers copy both. The date code made every
// line's chip unique, while what the trade prices by is the die: the last
// three letters of the FBGA code (VPP, TBH, CJV…). So a Micron value that ends
// in an FBGA code keeps just those three letters; anything else is kept as
// typed, for a person with the stick in hand to fix.
//
// The backfill in migrations/0167 is this rule's SQL twin, and
// tests/chip-number-canon.test.ts runs one against the other.

const MICRON_FBGA = /[CDZ][89]([A-Z]{3})$/;

export function chipMarkingCanon(raw: string, brand?: string | null): string {
  const t = raw.trim().toUpperCase();
  if (brand?.trim().toLowerCase() !== 'micron') return t;
  const m = t.replace(/[^A-Z0-9]/g, '').match(MICRON_FBGA);
  return m ? m[1] : t;
}
