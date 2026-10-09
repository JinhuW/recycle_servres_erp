type Translate = (key: string, vars?: Record<string, string | number>) => string;

type Named = { no?: number | null; partNumber?: string | null; description?: string | null };

// How a message names a PO product: its # once saved — the server gives it on
// save and never changes it. A product not saved yet has no # and shows *new*
// in the # column, so it is named by what it is: its part number, else its
// description.
export function lineRef(l: Named, t: Translate): string {
  if (l.no != null) return `#${l.no}`;
  const name = (l.partNumber ?? '').trim() || (l.description ?? '').trim();
  return name ? t('lineRefNewNamed', { name }) : t('lineRefNew');
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
