// One validator for the fields of a PO line, for every door that writes one:
// POST /api/orders, PATCH /api/orders/:id (lines and addLines) and the
// inventory editor. Each used to check its own subset — POST checked no number
// at all, so a negative unit cost was stored and a qty of 0 reached the CHECK
// as a bare "out of range". The database CHECKs stay as the backstop; the
// messages here are the ones a person can act on.
//
// `create` is a brand-new line: qty and unit cost must be there. `patch` is
// an edit: an absent field keeps its stored value, so only what is present is
// checked.
//
// A new line carries at least one unit. An existing PO line may be counted
// down to 0 (`allowZeroQty`) when none of it arrived: deleting it instead
// would renumber every line after it, since a line's # is its rank on the PO.

import { CASCADE_FIELDS, type CascadeField, type CascadeSpec, specConflicts } from '@recycle-erp/shared';

export type LineInputMode = 'create' | 'patch';

// Generous next to what is stored (the longest prod brand is 19 characters,
// the longest serial list 2,664): the point is a ceiling, not a format.
const TEXT_MAX: Record<string, number> = {
  category: 40, brand: 120, capacity: 60, type: 60, generation: 60,
  classification: 60, rank: 60, speed: 60, interface: 60, formFactor: 60,
  description: 1000, itemType: 120, partNumber: 120, chipNumber: 120,
  condition: 80, serialNumber: 20000,
};

const present = (v: unknown) => v !== undefined && v !== null;

export function validateLineInput(
  l: Record<string, unknown>,
  mode: LineInputMode,
  { allowZeroQty = false }: { allowZeroQty?: boolean } = {},
): string | null {
  const qty = l.qty;
  if (mode === 'create' && !present(qty)) return 'qty is required';
  const minQty = allowZeroQty ? 0 : 1;
  if (present(qty) && (typeof qty !== 'number' || !Number.isInteger(qty) || qty < minQty)) {
    return allowZeroQty ? 'qty must be a whole number of 0 or more' : 'qty must be a whole number of at least 1';
  }
  const unitCost = l.unitCost;
  if (mode === 'create' && !present(unitCost)) return 'unitCost is required';
  if (present(unitCost) && (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0)) {
    return 'unitCost must be a number of 0 or more';
  }
  // 0 is allowed: it is how a line is unpriced (shared/sellPrice).
  const sellPrice = l.sellPrice;
  if (present(sellPrice) && (typeof sellPrice !== 'number' || !Number.isFinite(sellPrice) || sellPrice < 0)) {
    return 'sellPrice must be a number of 0 or more';
  }
  const health = l.health;
  if (present(health) && (typeof health !== 'number' || !Number.isFinite(health) || health < 0 || health > 100)) {
    return 'health must be between 0 and 100';
  }
  const rpm = l.rpm;
  if (present(rpm) && (typeof rpm !== 'number' || !Number.isInteger(rpm) || rpm <= 0)) {
    return 'rpm must be a whole number above 0';
  }
  for (const [field, max] of Object.entries(TEXT_MAX)) {
    const v = l[field];
    if (!present(v)) continue;
    if (typeof v !== 'string') return `${field} must be text`;
    if (v.length > max) return `${field} is too long (max ${max} characters)`;
  }
  return null;
}

/**
 * What a spec text field stores: trimmed, with blank folded into NULL. An
 * empty string is not NULL to the brand facet or the top-brands rollup, which
 * would gain a ghost value.
 */
export function specVal(v: string | null | undefined): string | null {
  return v == null || v.trim() === '' ? null : v.trim();
}

const SPEC_COLS: Readonly<Record<CascadeField, string>> = {
  generation: 'generation', classification: 'classification', type: 'type',
  rank: 'rank', interface: 'interface', formFactor: 'form_factor',
};

/**
 * A stored line's specs after a patch, merged the way the UPDATE writes them —
 * a present key lands (null included), an absent one keeps the column unless a
 * category switch clears it — and which of them really change. The edit forms
 * echo every field back, so presence alone says nothing.
 */
export function mergedSpec(
  stored: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  { clearing = new Set<string>(), categoryMoved = false }: { clearing?: ReadonlySet<string>; categoryMoved?: boolean } = {},
): { merged: CascadeSpec; changed: Set<string> } {
  const merged: CascadeSpec = {};
  const changed = new Set<string>();
  for (const f of CASCADE_FIELDS) {
    const col = SPEC_COLS[f];
    const before = specVal(stored[col] as string | null);
    const after = patch[f] !== undefined
      ? specVal(patch[f] as string | null)
      : clearing.has(col) ? null : before;
    merged[f] = after;
    if (categoryMoved || after !== before) changed.add(f);
  }
  return { merged, changed };
}

/**
 * The refusal for a line whose RAM/SSD specs contradict each other (shared
 * specCascade), judging only the rules with a field in `changed` — prod holds
 * conflicting lines from before the rules, and an unrelated edit must save.
 */
export function specRuleErr(
  label: string,
  category: string,
  spec: CascadeSpec,
  changed: ReadonlySet<string> = new Set(CASCADE_FIELDS),
): string | null {
  const e = specConflicts(category, spec, changed);
  return e ? `${label}: ${e}` : null;
}
