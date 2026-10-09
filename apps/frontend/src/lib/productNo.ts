type Translate = (key: string, vars?: Record<string, string | number>) => string;

// How a message names a PO product: its # once saved — the server gives it on
// save and never changes it. A product not saved yet has no #, so it is named
// by its row (0-based `row`, when the caller lists several) to tell two new
// ones apart.
export function lineRef(l: { no?: number | null }, t: Translate, row?: number): string {
  if (l.no != null) return `#${l.no}`;
  return row != null ? t('lineRefNewRow', { n: row + 1 }) : t('lineRefNew');
}

// How many products a PO's lines are: one per #, since a partial transfer's
// clone repeats its source's #. A line not saved yet is a product of its own.
export function productCount(lines: ReadonlyArray<{ no?: number | null }>): number {
  const nos = new Set<number>();
  let unsaved = 0;
  for (const l of lines) {
    if (l.no != null) nos.add(l.no);
    else unsaved += 1;
  }
  return nos.size + unsaved;
}
