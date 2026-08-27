// Presentation rules that more than one purchase-order surface has to agree
// on. The phone list and the desktop table render the same row, and the order
// timeline and the global register render the same event — when the rule lives
// inside one of them the other drifts and the same PO reads two ways.

import { fmtUSD, fmtUSD0 } from './format';
import type { OrderEventChange } from './types';

/** `t` from useT(), passed down so these stay pure functions. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Tone for a figure that can land on either side of zero. An order's profit
 * counts priced lines only while its fees are subtracted whole, so a PO whose
 * lines nobody has priced yet is a genuine loss and must not read green.
 */
export const profitTone = (n: number): 'pos' | 'neg' => (n < 0 ? 'neg' : 'pos');

/** Signed money, in the ±$x form the per-category subtotals already use. */
export const signedUSD0 = (n: number, locale = 'en-US'): string =>
  (n > 0 ? '+' : n < 0 ? '−' : '') + fmtUSD0(Math.abs(n), locale);

/**
 * The `created` event's detail line.
 *
 * Every part of it is optional: a draft started on the phone names no category
 * and holds no lines, and printing those absences gave "null · 0 lines · 0
 * units". Whatever the event doesn't know is left out.
 */
export function createdEventParts(detail: Record<string, unknown>, t: Translate): string[] {
  const category = typeof detail.category === 'string' ? detail.category : null;
  // Rows synthesised by migration 0076 counted their lines at backfill time
  // rather than at creation, so those numbers contradict the line events
  // beneath them. Category alone.
  if (detail.backfilled) return category ? [category] : [];
  const lineCount = Number(detail.lineCount ?? 0);
  const qty = Number(detail.qty ?? 0);
  // Present only when a manager filed the PO for a purchaser — the actor line
  // above the row names the manager, so this names the owner.
  const behalf = typeof detail.onBehalfOfName === 'string' ? detail.onBehalfOfName : null;
  return [
    category,
    lineCount > 0 ? t(lineCount === 1 ? 'acNLine' : 'acNLines', { n: lineCount }) : null,
    qty > 0 ? t(qty === 1 ? 'acNUnit' : 'acNUnits', { n: qty }) : null,
    behalf ? t('acCreatedFor', { name: behalf }) : null,
  ].filter((p): p is string => !!p);
}

/**
 * The `owner_changed` event's one-line body: who held the PO, who holds it
 * now. Names are snapshotted into the event, so a renamed or deactivated
 * user still reads as they were at the time.
 */
export function ownerChangedLine(detail: Record<string, unknown>): string {
  const from = typeof detail.from === 'string' && detail.from ? detail.from : '—';
  const to = typeof detail.to === 'string' && detail.to ? detail.to : '—';
  return `${from} → ${to}`;
}

export const LIFECYCLE_LABEL: Record<string, string> = {
  draft:      'Draft',
  in_transit: 'In Transit',
  reviewing:  'Reviewing',
  done:       'Done',
};

// Friendly labels for the fields we surface on line_edited / meta_changed
// events and in the revert-review dialog. Anything not listed falls back to
// the raw db column name.
export const FIELD_LABEL: Record<string, string> = {
  sell_price:      'Sell price',
  qty:             'Qty',
  unit_cost:       'Unit cost',
  brand:           'Brand',
  capacity:        'Capacity',
  type:            'Type',
  generation:      'Generation',
  classification:  'Classification',
  rank:            'Rank',
  speed:           'Speed',
  interface:       'Interface',
  form_factor:     'Form factor',
  description:     'Description',
  part_number:     'Part number',
  serial_number:   'Serial number',
  chip_number:     'Chip number',
  condition:       'Condition',
  health:          'Health',
  rpm:             'RPM',
  notes:           'Notes',
  warehouse_id:    'Warehouse',
  payment:         'Payment',
  total_cost:      'Goods total',
  commission_rate: 'Commission rate',
  other_fees:      'Other fees',
  other_fees_note: 'Other fees note',
  paypal_txn_id:   'PayPal transaction ID',
};

const MONEY_FIELDS = new Set(['sell_price', 'unit_cost', 'total_cost', 'other_fees']);

/** One side of a field change, in the units that field is read in. */
export function renderValue(field: string, v: unknown, locale: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'commission_rate' && typeof v === 'number') return (v * 100).toFixed(2) + '%';
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return fmtUSD(v, locale);
  return String(v);
}

/** `Qty: 4 → 8`, the one form a field change takes wherever it is shown. */
export function changeLine(c: OrderEventChange, locale: string): string {
  const label = FIELD_LABEL[c.field] ?? c.field;
  return `${label}: ${renderValue(c.field, c.from, locale)} → ${renderValue(c.field, c.to, locale)}`;
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * The detail line behind a line-photo event: what was attached, how big, and
 * of what type. A removal records only the filename.
 */
export function linePhotoEventDetail(detail: Record<string, unknown>): string {
  const filename = typeof detail.filename === 'string' ? detail.filename : null;
  const size = typeof detail.size === 'number' ? fmtBytes(detail.size) : null;
  const mime = typeof detail.mime === 'string' ? detail.mime : null;
  return [filename, size, mime].filter((p): p is string => !!p).join(' · ');
}
