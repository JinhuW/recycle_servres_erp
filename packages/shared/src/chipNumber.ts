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

// Third-party modules (Kingston, ADATA…) carry Samsung, SK hynix or Micron
// dies, and purchasers type the marking every which way: `8DE75 D9VPP`,
// `SK-H5ANAG8NCJRXNC240VS`, `SAMSUNG CB1`. Only a whole die code counts: a
// Samsung K4A marking names the revision, not BB1 vs CB1, and a Hynix marking
// cut before its package letter (`H5ANAG8NCJ`) is left unknown, not completed.
const HYNIX_DIE = /H5AN(?:4G|8G|AG)(?:4|8|6|16)N([A-Z]{2}R)/;
const MAKER_PREFIX = /^(?:(SK ?HYNIX|SK)|SAMSUNG|MICRON|M)[\s_-]+/;
const BARE_DIE = /^(?:[A-EM][BM]\d|[A-Z]{3})$/;
const NOT_A_DIE = new Set(['NIL', 'UNK', 'TBD', 'OEM', 'ALL']);

/** The three-character die code a Chip # names, read from any maker's marking; null when it names none. */
export function chipDieCode(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  const compact = t.replace(/[^A-Z0-9]/g, '');
  const die = compact.match(MICRON_FBGA)?.[1] ?? compact.match(HYNIX_DIE)?.[1];
  if (die) return die;
  const hynix = MAKER_PREFIX.exec(t)?.[1] != null;
  const bare = t.replace(MAKER_PREFIX, '');
  // Every hynix die code ends in its package letter; `SK NCJ` is a cut marking.
  if (hynix && !/R$/.test(bare)) return null;
  return BARE_DIE.test(bare) && !NOT_A_DIE.has(bare) ? bare : null;
}
