import { staleSpecFields } from '@recycle-erp/shared';
import type { Category } from './types';

// Moving a line between categories clears the spec fields the old category
// owned. The backend NULLs the matching columns from the same table
// (staleSpecDbCols), so the form and the row can't disagree — without this the
// drawer would keep sending a stale `interface` on a line that is now RAM and
// the two sides would silently diverge.
//
// Returns a patch, not a whole line, so callers can feed it straight into the
// same onChange they use for every other field.
export function switchLineCategory<T extends Record<string, unknown>>(
  line: T,
  next: Category,
): Partial<T> & { category: Category } {
  const patch: Record<string, unknown> = { category: next };
  for (const field of staleSpecFields(next)) {
    if (line[field] !== undefined && line[field] !== null && line[field] !== '') {
      // null rather than '' so a select renders its placeholder and the wire
      // shape reads as "cleared" rather than "set to empty string".
      patch[field] = null;
    }
  }
  return patch as Partial<T> & { category: Category };
}

/** The fields `switchLineCategory` would blank, for the undo notice. */
export function clearedBySwitch(line: Record<string, unknown>, next: Category): string[] {
  return staleSpecFields(next).filter(
    f => line[f] !== undefined && line[f] !== null && line[f] !== '',
  );
}

// Spec field → the i18n key that labels it in the form. The field names don't
// all double as keys (`speed` is labelled by `speedMhz`, `classification` by
// `klass`), so the undo notice has to go through this rather than t(field).
export const SPEC_FIELD_LABEL_KEY: Readonly<Record<string, string>> = {
  brand: 'brand',
  capacity: 'capacity',
  generation: 'generation',
  type: 'type',
  classification: 'klass',
  rank: 'rank',
  speed: 'speedMhz',
  chipNumber: 'chipNumber',
  interface: 'interfaceLbl',
  formFactor: 'formFactor',
  health: 'healthPct',
  rpm: 'rpm',
  description: 'lfItemDescription',
  itemType: 'lfItemType',
};
