type Translate = (key: string, vars?: Record<string, string | number>) => string;

type Named = { no?: number | null; partNumber?: string | null; description?: string | null };

// How a message names a PO product: its # once saved — the server gives it on
// save and never changes it. A product not saved yet has no #; the # column
// counts those rows *new 1*, *new 2*… (`newNo`, from newOrdinals), so the
// message says that number, and what the product is: two new rows of one part
// read apart.
export function lineRef(l: Named, t: Translate, newNo?: number | null): string {
  if (l.no != null) return `#${l.no}`;
  const name = (l.partNumber ?? '').trim() || (l.description ?? '').trim();
  if (newNo != null) return name ? t('lineRefNewNNamed', { n: newNo, name }) : t('lineRefNewN', { n: newNo });
  return name ? t('lineRefNewNamed', { name }) : t('lineRefNew');
}

// Each line's place among the unsaved ones, 1-based, in list order — what the
// # column shows for them — and null for a saved line.
export function newOrdinals(lines: ReadonlyArray<{ no?: number | null }>): (number | null)[] {
  let n = 0;
  return lines.map((l) => (l.no != null ? null : ++n));
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
