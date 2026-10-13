// Required-field policy for RAM purchase-order lines: every spec field that
// identifies the part must be filled before a line can be saved or submitted.
// Shared by the desktop submit drawer and the mobile submit form, whose line
// shapes differ only in null vs undefined for blanks.

import { isDdr3 } from '@recycle-erp/shared';

export type RamRequiredLine = {
  brand?: string | null;
  capacity?: string | null;
  generation?: string | null;
  type?: string | null;
  classification?: string | null;
  rank?: string | null;
  speed?: string | null;
  chipNumber?: string | null;
  partNumber?: string | null;
};

// Line-field key → i18n label key, in the order fields appear on the forms.
const RAM_REQUIRED_FIELDS: readonly (readonly [keyof RamRequiredLine, string])[] = [
  ['brand', 'brand'],
  ['capacity', 'capacity'],
  ['generation', 'generation'],
  ['type', 'type'],
  ['classification', 'klass'],
  ['rank', 'rank'],
  ['speed', 'speedMhz'],
  ['chipNumber', 'chipNumber'],
  ['partNumber', 'partNumber'],
];

// Micron and off-catalog ("Other") modules can't be identified from the part
// number alone, so the chip marking is what pins them down. Every other brand
// carries a self-describing part number — asking for the chip # there is busy
// work. A blank brand asks for nothing: brand itself is already flagged.
const CHIP_NUMBER_BRANDS: ReadonlySet<string> = new Set(['micron', 'other']);

export function chipNumberRequired(brand?: string | null): boolean {
  return CHIP_NUMBER_BRANDS.has((brand ?? '').trim().toLowerCase());
}

// DDR3 is end-of-life stock that trades by capacity and module form; the
// label details that identify a DDR4/DDR5 part aren't worth blocking a line
// on. A lot without a part number is filed under these two (shared synth).
const DDR3_REQUIRED: ReadonlySet<keyof RamRequiredLine> = new Set(['capacity', 'generation', 'type']);

// Whether `key` must be filled on this line — the one answer the labels' `*`
// and the blockers share, so a starred field is always one the save asks for.
export function ramFieldRequired(line: RamRequiredLine, key: keyof RamRequiredLine): boolean {
  if (isDdr3(line.generation)) return DDR3_REQUIRED.has(key);
  return key !== 'chipNumber' || chipNumberRequired(line.brand);
}

// I18n label keys of the required fields that are still blank, in form order.
export function missingRamFields(line: RamRequiredLine): string[] {
  return RAM_REQUIRED_FIELDS
    .filter(([key]) => ramFieldRequired(line, key))
    .filter(([key]) => !(line[key] ?? '').trim())
    .map(([, labelKey]) => labelKey);
}
