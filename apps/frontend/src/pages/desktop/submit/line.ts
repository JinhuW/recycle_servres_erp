import type { Category, ScanResponse } from '../../../lib/types';
import type { LinePhoto } from '../../../lib/linePhotos';
import { ramBrandNeedsConfirm } from '../../../lib/scanValidation';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// The line model shared by the capture form (DesktopSubmit), the edit page
// (DesktopEditOrder) and the line drawer — kept apart from both pages so the
// drawer does not import back into the page that renders it.
export type Line = {
  category: Category;
  brand?: string;
  capacity?: string;
  generation?: string;
  type?: string;
  classification?: string;
  rank?: string;
  speed?: string;
  interface?: string;
  formFactor?: string;
  description?: string;
  itemType?: string;
  partNumber?: string;
  serialNumber?: string;
  chipNumber?: string;
  condition: string;
  qty: number | string;
  unitCost: number | string;
  sellPrice?: number | string;
  health?: number | null;
  rpm?: number | null;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
  scanImageId?: string | null;
  scanConfidence?: number | null;
  scanImageUrl?: string | null;
  _confirmed?: boolean;
  // Set by a scan whose brand the AI couldn't name; cleared when the purchaser
  // confirms it against the photo. Lives on the line, not in drawer state, so
  // closing and reopening the drawer can't shake the question off.
  _brandNeedsConfirm?: boolean;
  _cid: string;                  // stable client id for React keys (never sent to the API)
  // DB id, once the line has been persisted. Null before that — which is why
  // photos are buffered rather than uploaded as they're picked.
  _dbId?: string | null;
  photos?: LinePhoto[];
};

export function blankLine(cat: Category): Line {
  return {
    _cid: crypto.randomUUID(),
    category: cat, qty: '', unitCost: '',
    condition: '',
    scanImageUrl: null,
  };
}

export type DuplicatePartGroup = { partNumber: string; lineNums: number[] };

// Two lines sharing a part number on the same PO is almost always a paste-error
// or a forgotten-already-added — surface it so the user can merge or confirm.
// Comparison is case-insensitive and trims whitespace; blanks are ignored. The
// returned `partNumber` carries the first-seen casing for display.
export function findDuplicatePartNumbers(
  lines: ReadonlyArray<{ partNumber?: string | null }>,
): DuplicatePartGroup[] {
  const groups = new Map<string, DuplicatePartGroup>();
  lines.forEach((l, i) => {
    const raw = (l.partNumber ?? '').trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    const g = groups.get(key);
    if (g) g.lineNums.push(i + 1);
    else groups.set(key, { partNumber: raw, lineNums: [i + 1] });
  });
  return [...groups.values()].filter(g => g.lineNums.length >= 2);
}

// Build a Line patch from an AI scan response — mirrors the mobile aiDefaults
// in SubmitForm.tsx so all flows share the same field-mapping. Returned as a
// Partial so callers can either spread it onto blankLine() (new line) or pass
// it through onChange() (live edit in the drawer).
// Low-confidence extractions are still prefilled (a rough draft beats an empty
// form); scanConfidence rides along so the drawer can flag it for review.
export function scanToLinePatch(scan: ScanResponse, category?: Category): Partial<Line> {
  const f = scan.extracted ?? {};
  return {
    scanImageId: scan.imageId ?? null,
    _brandNeedsConfirm: category === 'RAM' && ramBrandNeedsConfirm(f),
    scanConfidence: scan.confidence ?? null,
    scanImageUrl: scan.deliveryUrl ?? null,
    ...(f.brand        ? { brand: f.brand }               : {}),
    ...(f.capacity     ? { capacity: f.capacity }         : {}),
    ...(f.generation   ? { generation: f.generation }     : {}),
    ...(f.type         ? { type: f.type }                 : {}),
    ...(f.classification ? { classification: f.classification } : {}),
    ...(f.rank         ? { rank: f.rank }                 : {}),
    ...(f.speed        ? { speed: f.speed }               : {}),
    ...(f.interface    ? { interface: f.interface }       : {}),
    ...(f.formFactor   ? { formFactor: f.formFactor }     : {}),
    ...(f.description  ? { description: f.description }   : {}),
    ...(f.rpm          ? { rpm: Number(f.rpm) }           : {}),
    ...(f.partNumber   ? { partNumber: f.partNumber }     : {}),
  };
}

/**
 * Whether this line still owes a brand the purchaser has checked against the
 * scan photo. Every path that persists a line asks this — the drawer's confirm
 * button is only one of four. The category test matters: switching a scanned
 * RAM line to another category leaves the flag behind, and an SSD line must
 * not be asked a RAM question.
 *
 * The second test re-runs the same rule against the line's *own* brand, so
 * picking a real one in the Brand select answers the question as well as the
 * dialog does — being asked to re-pick what you just picked reads as a bug.
 * `Other` and off-catalog values still prompt: `Other` is the catalog's "I
 * don't know", which is precisely what the dialog is for. Note the flag itself
 * stays `true` on a line settled this way — only the dialog's confirm clears
 * it — but nothing else reads it and it never reaches the API.
 */
export const brandConfirmPending = (l: Line): boolean =>
  l.category === 'RAM'
  && !!l._brandNeedsConfirm
  && ramBrandNeedsConfirm({ brand: l.brand ?? '' });

/** Index → the other 1-based line numbers sharing that line's part number. */
export function duplicatesByIndex(
  groups: readonly DuplicatePartGroup[],
): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const g of groups) {
    for (const ln of g.lineNums) {
      m.set(ln - 1, g.lineNums.filter(n => n !== ln));
    }
  }
  return m;
}

/**
 * One message per line that still holds up a save or a submit: the brand
 * check first, then the missing fields by name, then a generic nudge.
 */
export function lineBlockerMessages<L extends Line>(
  lines: readonly L[],
  t: Translate,
  lineReady: (l: L) => boolean,
  missingNamesFor: (l: L) => string | null,
): string[] {
  return lines.flatMap((l, i) => {
    if (brandConfirmPending(l)) {
      return [lines.length === 1
        ? t('subConfirmBrandThis')
        : t('subConfirmBrandLine', { n: i + 1 })];
    }
    if (lineReady(l)) return [];
    const fields = missingNamesFor(l);
    if (fields) {
      return [lines.length === 1
        ? t('subMissingFieldsThis', { fields })
        : t('subMissingFieldsLine', { n: i + 1, fields })];
    }
    return [lines.length === 1 ? t('subFillThisLine') : t('subFillLineN', { n: i + 1 })];
  });
}
