import { CATEGORY_ORDER, type ExportCategory } from '@recycle-erp/shared';
import type { XlsxColumn } from './xlsx';

export { CATEGORY_ORDER };
export type { ExportCategory };

// The category → granular spec column table, shared by every workbook that
// itemizes stock (the inventory export and the PO spreadsheet). One column per
// submit-form field: specs are never re-merged into a single composed string
// (user-confirmed 2026-07-23) because buyers sort and filter on them.
//
// This table is the one source of truth for those column sets. The vendor bid
// sheet keeps its own copy on purpose — its header text is load-bearing for the
// round-trip price import parser, so it must not move when this one does.

export const SPEC_COLS_BY_CATEGORY: Record<ExportCategory, XlsxColumn[]> = {
  RAM: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Chip #',      key: 'chip',           width: 22 },
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Gen',         key: 'generation',     width: 8 },
    { header: 'Type',        key: 'type',           width: 10 },
    { header: 'Class',       key: 'classification', width: 10 },
    { header: 'Rank',        key: 'rank',           width: 8 },
    { header: 'Speed',       key: 'speed',          width: 10 },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
  SSD: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Interface',   key: 'interface',      width: 12 },
    { header: 'Form factor', key: 'formFactor',     width: 12 },
    { header: 'Health %',    key: 'health',         width: 10, numFmt: '#,##0' },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
  HDD: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Interface',   key: 'interface',      width: 12 },
    { header: 'Form factor', key: 'formFactor',     width: 12 },
    { header: 'RPM',         key: 'rpm',            width: 8,  numFmt: '#,##0' },
    { header: 'Health %',    key: 'health',         width: 10, numFmt: '#,##0' },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
  Other: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Type',        key: 'itemType',       width: 16 },
    { header: 'Description', key: 'description',    width: 30 },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
};

// Categories that were disabled or renamed after the fact still have rows in
// order_lines, and they have to land on a sheet that exists.
export function exportCategory(v: unknown): ExportCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(String(v))
    ? (String(v) as ExportCategory)
    : 'Other';
}

export type CategorySheet = { name: string; columns: XlsxColumn[]; rows: Record<string, unknown>[] };

// One worksheet per category present, in CATEGORY_ORDER, unknown categories
// folded into Other. The spec column sets are disjoint, so a sheet holding two
// categories would silently drop the off-sheet ones' specs — exceljs renders
// only the keys its column set declares.
//
// `singleSheetName`, when given, keeps a uniform result on ONE sheet under that
// name: the PO workbook must stay byte-identical for a single-category order.
// An empty result still needs a valid file, so it falls back to that sheet too.
export function categoryTabSheets(
  rows: Record<string, unknown>[],
  colsFor: (cat: ExportCategory) => XlsxColumn[],
  opts: { singleSheetName?: string; emptySheetName: string },
): CategorySheet[] {
  const byCategory = new Map<ExportCategory, Record<string, unknown>[]>();
  for (const r of rows) {
    const cat = exportCategory(r.category);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }
  const present = CATEGORY_ORDER.filter((cat) => byCategory.has(cat));
  if (present.length === 0) {
    return [{ name: opts.emptySheetName, columns: colsFor('Other'), rows: [] }];
  }
  if (present.length === 1 && opts.singleSheetName) {
    return [{ name: opts.singleSheetName, columns: colsFor(present[0]), rows: byCategory.get(present[0])! }];
  }
  return present.map((cat) => ({
    name: cat as string,
    columns: colsFor(cat),
    rows: byCategory.get(cat)!,
  }));
}

// Maps a raw order_lines row onto the spec keys above. Every key is emitted
// unconditionally — exceljs renders only the keys the selected column set
// declares, which keeps callers branch-free. Numeric attrs stay null (not 0)
// when absent so the cell reads blank rather than a real zero.
export function lineSpecFields(l: Record<string, unknown>) {
  return {
    part: l.part_number ?? '',
    chip: l.chip_number ?? '',
    brand: l.brand ?? '',
    capacity: l.capacity ?? '',
    generation: l.generation ?? '',
    type: l.type ?? '',
    classification: l.classification ?? '',
    rank: l.rank ?? '',
    speed: l.speed ?? '',
    interface: l.interface ?? '',
    formFactor: l.form_factor ?? '',
    health: l.health ?? null,
    rpm: l.rpm ?? null,
    description: l.description ?? '',
    itemType: l.item_type ?? '',
    condition: l.condition ?? '',
  };
}
