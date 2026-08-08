// Which spec fields belong to which category.
//
// A purchase order can mix categories, so a line's category is editable — and
// changing it has to clear the fields the old category owned. An SSD line
// switched to RAM must not keep its `interface`, or the line reads as an SSD
// that claims to be memory and the inventory facets split on a ghost value.
//
// The backend clears DB columns and the frontend clears form state from THIS
// table, which is why both spellings live here rather than one per side. They
// are kept in lockstep by a parity test — if you add a field, add it to both.
//
// Fields absent from every list are category-agnostic and survive a switch:
// part_number, serial_number, condition, qty, unit_cost, sell_price, status,
// position, scan_image_id, scan_confidence.

export const SPEC_FIELDS_BY_CATEGORY = {
  RAM:   ['brand', 'capacity', 'generation', 'type', 'classification', 'rank', 'speed', 'chipNumber'],
  SSD:   ['brand', 'capacity', 'interface', 'formFactor', 'health'],
  HDD:   ['brand', 'capacity', 'interface', 'formFactor', 'health', 'rpm'],
  Other: ['description', 'itemType'],
} as const satisfies Record<string, readonly string[]>;

export const SPEC_DB_COLS_BY_CATEGORY = {
  RAM:   ['brand', 'capacity', 'generation', 'type', 'classification', 'rank', 'speed', 'chip_number'],
  SSD:   ['brand', 'capacity', 'interface', 'form_factor', 'health'],
  HDD:   ['brand', 'capacity', 'interface', 'form_factor', 'health', 'rpm'],
  Other: ['description', 'item_type'],
} as const satisfies Record<string, readonly string[]>;

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** camelCase → snake_case, for the handful of spec fields that differ. */
export const SPEC_FIELD_TO_DB_COL: Readonly<Record<string, string>> = Object.fromEntries(
  [...new Set(Object.values(SPEC_DB_COLS_BY_CATEGORY).flat())].map((col) => [camel(col), col]),
);

/** Every spec field any category owns, in either spelling. */
const ALL_SPEC_FIELDS: readonly string[] =
  [...new Set(Object.values(SPEC_FIELDS_BY_CATEGORY).flat())];
const ALL_SPEC_DB_COLS: readonly string[] =
  [...new Set(Object.values(SPEC_DB_COLS_BY_CATEGORY).flat())];

const owned = <T extends readonly string[]>(
  map: Record<string, T>,
  all: readonly string[],
  category: string,
): readonly string[] => {
  const keep = new Set<string>(map[category] ?? []);
  // An unknown category (disabled, renamed, or from an older release) owns
  // nothing we can name, so clear nothing — dropping a legacy line's specs on
  // an unrelated edit would be silent data loss.
  if (!map[category]) return [];
  return all.filter((f) => !keep.has(f));
};

/** Spec fields to blank when a line moves TO `category` (camelCase). */
export const staleSpecFields = (category: string): readonly string[] =>
  owned(SPEC_FIELDS_BY_CATEGORY as unknown as Record<string, readonly string[]>, ALL_SPEC_FIELDS, category);

/** Spec columns to NULL when a line moves TO `category` (snake_case). */
export const staleSpecDbCols = (category: string): readonly string[] =>
  owned(SPEC_DB_COLS_BY_CATEGORY as unknown as Record<string, readonly string[]>, ALL_SPEC_DB_COLS, category);
