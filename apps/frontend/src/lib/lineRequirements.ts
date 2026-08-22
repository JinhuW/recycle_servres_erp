import { missingRamFields, type RamRequiredLine } from './ramRequired';

// What a purchase-order line still needs before it can be saved — one rule for
// every screen that asks the question. Capture, the editor and the phone form
// each grew their own copy, so the same blank field was named "Qty" on one and
// "Quantity" on another, and a RAM line missing its speed was blocked at
// capture yet saveable in the editor. The keys returned here are the i18n keys
// of the labels the forms print, so a message can never name a field by a word
// that isn't on screen.

export type RequirementLine = RamRequiredLine & {
  category: string;
  description?: string | null;
  itemType?: string | null;
  qty?: number | string | null;
};

// Small SSDs move as anonymous bulk lots, so brand isn't worth blocking on.
// Above this size a drive is an enterprise part whose value depends on who
// made it, so the brand becomes part of the line's identity.
export const SSD_BRAND_REQUIRED_OVER_GB = 800;

/** Catalog capacity string ("960GB", "1.92TB") as gigabytes, or null. */
export function capacityGb(capacity?: string | null): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(GB|TB)\s*$/i.exec(capacity ?? '');
  if (!m) return null;
  return Number(m[1]) * (m[2].toUpperCase() === 'TB' ? 1000 : 1);
}

/** Whether an SSD line's capacity puts it over the brand-required threshold. */
export function ssdBrandRequired(capacity?: string | null): boolean {
  const gb = capacityGb(capacity);
  return gb != null && gb > SSD_BRAND_REQUIRED_OVER_GB;
}

/** Label keys of the identity fields a non-RAM category insists on. */
function missingIdentityFields(line: RequirementLine): string[] {
  if (line.category === 'RAM') return missingRamFields(line);
  // An `Other` line is identified by its type and its part number. The
  // description is prose — helpful, but two people write it two ways, so it
  // can't be what the line is looked up by. Both shells already refuse to
  // submit a part-number-less line; asking here names it while the line is
  // still open instead of at submit.
  if (line.category === 'Other') {
    return [
      ...(!(line.itemType ?? '').trim() ? ['lfItemType'] : []),
      ...(!(line.partNumber ?? '').trim() ? ['lfPartSku'] : []),
    ];
  }
  if (line.category === 'SSD' && !ssdBrandRequired(line.capacity)) return [];
  return (line.brand ?? '').trim() ? [] : ['brand'];
}

/**
 * The required fields still blank, in form order, and whether the line is
 * complete. Unit cost is absent on purpose: a blank one reads as 0, which is a
 * legitimate cost for a line thrown in with a lot.
 */
export function lineRequirements(line: RequirementLine): {
  ready: boolean;
  missingKeys: string[];
} {
  const missingKeys = missingIdentityFields(line);
  if (!(Number(line.qty) > 0)) missingKeys.push('qty');
  return { ready: missingKeys.length === 0, missingKeys };
}

/**
 * "Brand, Speed (MHz), …" for a message, or null when nothing is missing.
 * Chinese lists with an ideographic comma, which is what a reader expects and
 * what every other enumeration in the app uses.
 */
export function missingFieldNames(
  keys: readonly string[],
  t: (key: string) => string,
  lang: string,
): string | null {
  return keys.length ? keys.map(t).join(lang === 'zh' ? '、' : ', ') : null;
}
