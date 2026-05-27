// After /api/scan/label returns, we have an "extracted" map of field→value.
// The Submit forms prefill the line straight from that map and pass each value
// into a <select> backed by the catalog (RAM_RANK, SSD_INTERFACE, …). A native
// <select> whose value isn't one of its <option>s renders empty — so an AI
// extraction with a near-miss like rank='2Rx32' (not in the catalog) silently
// vanishes from the form, with no signal to the user that the model actually
// read something.
//
// This module finds those near-misses and reports them so:
//   1. the caller can strip them from the prefilled line (avoids the
//      silent-blank state), and
//   2. the UI can show a warning listing what was read but rejected, so the
//      user knows whether to verify, re-shoot, or extend the catalog.

import type { Category } from './types';
import { catalog } from './lookups';

// Maps each extracted-field name to the catalog group whose values must contain
// the extracted value. Fields not listed here are free-text (partNumber,
// description, speed — which is now a literal pass-through from the label,
// so non-catalog numbers like 2666 / 12800 must survive prefill) or hardcoded
// enums not in the DB catalog (RAM device type — Desktop|Server|Laptop).
const CATALOG_GROUPS: Record<Category, Partial<Record<string, keyof typeof catalog>>> = {
  RAM: {
    brand:          'RAM_BRAND',
    capacity:       'RAM_CAP',
    generation:     'RAM_TYPE',   // legacy catalog name; values are DDR3/DDR4/DDR5
    classification: 'RAM_CLASS',
    rank:           'RAM_RANK',
  },
  SSD: {
    brand:      'SSD_BRAND',
    capacity:   'SSD_CAP',
    interface:  'SSD_INTERFACE',
    formFactor: 'SSD_FORM',
  },
  HDD: {
    brand:      'HDD_BRAND',
    capacity:   'HDD_CAP',
    interface:  'HDD_INTERFACE',
    formFactor: 'HDD_FORM',
    rpm:        'HDD_RPM',
  },
  Other: {},
};

export type UnmatchedField = {
  field: string;
  value: string;
  // The catalog group's accepted values, so the UI can show "expected: X | Y"
  // when it makes sense (short lists). Empty array if the catalog hasn't
  // loaded yet (treat the value as unmatched-but-unverifiable).
  options: string[];
};

export type ScanValidation = {
  // Fields the model returned with values that aren't in the catalog. Use
  // these to drop those keys from the line so the dropdown isn't broken.
  unmatched: UnmatchedField[];
};

/**
 * Returns the catalog group name a given (category, field) is backed by, or
 * null if it's a free-text / non-catalog field.
 */
export function catalogGroupFor(category: Category, field: string): keyof typeof catalog | null {
  return CATALOG_GROUPS[category]?.[field] ?? null;
}

/**
 * Walk the AI-extracted fields and flag any value that isn't in the catalog
 * for its field. Pure — reads the already-loaded `catalog` arrays from
 * lib/lookups.ts module state.
 */
export function validateScan(
  category: Category,
  extracted: Record<string, string> | null | undefined,
): ScanValidation {
  if (!extracted) return { unmatched: [] };
  const unmatched: UnmatchedField[] = [];
  for (const [field, value] of Object.entries(extracted)) {
    if (!value) continue;
    const group = catalogGroupFor(category, field);
    if (!group) continue;
    const options = catalog[group] ?? [];
    // If the catalog hasn't loaded yet (empty array), we can't say "not in
    // list" with confidence — skip rather than emit a false warning.
    if (options.length === 0) continue;
    if (!options.includes(value)) {
      unmatched.push({ field, value, options });
    }
  }
  return { unmatched };
}

/**
 * Convenience: copy `extracted` with the unmatched fields removed, so the
 * caller can prefill a line without poisoning the dropdowns.
 */
export function stripUnmatched(
  extracted: Record<string, string>,
  unmatched: UnmatchedField[],
): Record<string, string> {
  if (unmatched.length === 0) return extracted;
  const drop = new Set(unmatched.map(u => u.field));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extracted)) {
    if (!drop.has(k)) out[k] = v;
  }
  return out;
}
