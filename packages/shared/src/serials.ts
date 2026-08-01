// Serial-number parsing and validation, shared by the frontend forms and the
// backend order routes so the two sides can never disagree on what counts as
// a valid set of serials.
//
// Serials are stored as a single free-text blob (the entry UI is a multi-line
// textarea — one SN per line, commas/semicolons tolerated).

export function parseSerials(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Structural view of a line — only the fields the serial rules read.
export type SerialCheckLine = {
  category?: string | null;
  generation?: string | null;
  qty?: number | string | null;
  serialNumber?: string | null;
};

export type SerialIssue =
  | { kind: 'ddr5Required' }
  | { kind: 'countMismatch'; count: number; qty: number };

// Two rules, checked in order:
//  1. DDR5 RAM must have serial numbers (per-module tracking is mandatory for
//     that generation).
//  2. Whenever serials ARE entered — any category — their count must equal the
//     line quantity; anything else is a data-entry error.
// Returns the first violated rule, or null when the line is fine. Lines with
// no serials and no DDR5 requirement pass untouched.
export function serialIssue(line: SerialCheckLine): SerialIssue | null {
  const serials = parseSerials(line.serialNumber);
  const qty = Math.floor(Number(line.qty ?? 0)) || 0;
  const isDdr5 =
    (line.category ?? '') === 'RAM' &&
    (line.generation ?? '').trim().toUpperCase() === 'DDR5';
  if (isDdr5 && serials.length === 0) return { kind: 'ddr5Required' };
  if (serials.length > 0 && qty > 0 && serials.length !== qty) {
    return { kind: 'countMismatch', count: serials.length, qty };
  }
  return null;
}
