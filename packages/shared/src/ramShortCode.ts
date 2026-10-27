import { chipMarkingCanon } from './chipNumber.js';
import { canonicalPartNumber } from './partNumberCanon.js';

export type RamShortCodeInput = {
  brand?: unknown;
  partNumber?: unknown;
  chipNumber?: unknown;
};

const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

/** The market code read from a module number or its recorded Micron chip. */
export function ramShortCode(row: RamShortCodeInput): string | null {
  const brand = text(row.brand).toUpperCase();
  if (brand === 'MICRON') {
    // A module number can ship with several dies; only its chip marking says
    // which one this lot carries. Existing three-letter codes need no lookup.
    const chip = chipMarkingCanon(text(row.chipNumber), 'Micron');
    return /^[A-Z]{3}$/.test(chip) ? chip : null;
  }
  const pn = canonicalPartNumber(text(row.partNumber));
  if (brand === 'SAMSUNG') {
    return pn.match(/^M[34]\d{2}[ABR][A-Z0-9]{4}([A-Z0-9]{3})(?:[A-Z][A-Z0-9]{2,})?$/)?.[1] ?? null;
  }
  if (brand === 'SK HYNIX') {
    // HMA42GR7 MFR 4N: the organisation digit and PCB letter follow the
    // market code. HMC DDR5 uses another scheme and must not be sliced here.
    return pn.match(/^HM[AT][1-58A][A-Z0-9]{2}[URLSPV][67]([A-Z0-9]{2}[A-Z])[468][A-Z](?:[A-Z][A-Z0-9]+)?$/)?.[1] ?? null;
  }
  return null;
}

/** Distinct codes in a group, with an unknown member kept visible too. */
export function ramShortCodes(rows: readonly RamShortCodeInput[]): (string | null)[] {
  return [...new Set(rows.map(ramShortCode))].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a.localeCompare(b));
}
