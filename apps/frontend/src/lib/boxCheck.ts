import { canonicalPartNumber, parseSerials } from '@recycle-erp/shared';
import type { Translate } from './orderPresentation';

// Box check: a manager counting a PO's lines against the box that arrived.
// Pure — the page owns the state, this decides what it means.

export const BOX_CHECK_REASONS = ['missing', 'short', 'wrong_part', 'damaged', 'not_as_described'] as const;
export type BoxCheckReason = typeof BOX_CHECK_REASONS[number];

export type LineCheck = {
  lineId: string;
  counted: number;
  flagReason: BoxCheckReason | null;
  flagNote: string | null;
  checkedAt: string | null;
};
export type CheckExtra = { id: string; partNumber: string; note: string | null; createdAt: string };
export type ChecksResponse = { lines: LineCheck[]; extras: CheckExtra[] };

export type CheckableLine = {
  id: string; qty: number; partNumber: string | null; serialNumber: string | null;
};

export type LineCheckState = 'open' | 'partial' | 'flagged' | 'done';

export function emptyCheck(lineId: string): LineCheck {
  return { lineId, counted: 0, flagReason: null, flagNote: null, checkedAt: null };
}

// A flag outranks the count: a line counted in full but flagged damaged still
// needs a decision, so it must not sink with the checked ones.
export function lineState(line: CheckableLine, check: LineCheck | undefined): LineCheckState {
  if (check?.flagReason) return 'flagged';
  const n = Math.min(check?.counted ?? 0, line.qty);
  if (n >= line.qty) return 'done';
  return n > 0 ? 'partial' : 'open';
}

export type OrderedLines<L> = { open: L[]; flagged: L[]; done: L[] };

// Open lines keep the PO's order so the list still reads against the
// paperwork; checked lines sink, newest first, so the one just ticked lands
// right under the divider where the eye follows it.
export function orderLines<L extends CheckableLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>,
): OrderedLines<L> {
  const out: OrderedLines<L> = { open: [], flagged: [], done: [] };
  for (const l of lines) {
    const s = lineState(l, checks.get(l.id));
    if (s === 'flagged') out.flagged.push(l);
    else if (s === 'done') out.done.push(l);
    else out.open.push(l);
  }
  const at = (l: L) => checks.get(l.id)?.checkedAt ?? '';
  out.done.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  return out;
}

export type Tally = {
  units: number; counted: number;
  open: number; partial: number; flagged: number; done: number;
};

export function tally(lines: readonly CheckableLine[], checks: ReadonlyMap<string, LineCheck>): Tally {
  const t: Tally = { units: 0, counted: 0, open: 0, partial: 0, flagged: 0, done: 0 };
  for (const l of lines) {
    const c = checks.get(l.id);
    t.units += l.qty;
    t.counted += Math.min(c?.counted ?? 0, l.qty);
    t[lineState(l, c)] += 1;
  }
  return t;
}

// A scanner types the label and presses Enter. Exact part number first, then
// a prefix (labels often carry a suffix the PO line doesn't), then a serial.
// Among several lines with the same part number, the first one still short
// takes the unit.
export function matchScan<L extends CheckableLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>, raw: string,
): L | null {
  const q = canonicalPartNumber(raw);
  if (!q) return null;
  const pick = (hits: L[]): L | null =>
    hits.find(l => (checks.get(l.id)?.counted ?? 0) < l.qty) ?? hits[0] ?? null;
  const exact = lines.filter(l => canonicalPartNumber(l.partNumber) === q);
  if (exact.length) return pick(exact);
  if (q.length >= 6) {
    const prefix = lines.filter(l => {
      const pn = canonicalPartNumber(l.partNumber);
      return pn.length >= 6 && (q.startsWith(pn) || pn.startsWith(q));
    });
    if (prefix.length) return pick(prefix);
  }
  const serial = lines.filter(l => parseSerials(l.serialNumber).some(s => canonicalPartNumber(s) === q));
  return pick(serial);
}

// After a line is checked or flagged the selection moves on to the next line
// still open below it (wrapping), so the keyboard flow continues.
export function nextOpenAfter<L extends CheckableLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>, fromId: string,
): L | null {
  const open = orderLines(lines, checks).open;
  if (!open.length) return null;
  const idx = lines.findIndex(l => l.id === fromId);
  return open.find(l => lines.indexOf(l) > idx) ?? open[0] ?? null;
}

export function boxCheckReasonKey(r: BoxCheckReason | string): string {
  switch (r) {
    case 'missing': return 'bcReasonMissing';
    case 'short': return 'bcReasonShort';
    case 'wrong_part': return 'bcReasonWrongPart';
    case 'damaged': return 'bcReasonDamaged';
    default: return 'bcReasonNotAsDescribed';
  }
}

type FlagDetail = { partNumber?: string | null; reason?: string; note?: string | null };
type ExtraDetail = { partNumber?: string; note?: string | null };

// A `box_check_flagged` event, read the same way on the PO page's log and the
// Activity page.
export function boxCheckEventLines(d: Record<string, unknown>, t: Translate): { count: number; lines: string[] } {
  const flags = Array.isArray(d.flags) ? d.flags as FlagDetail[] : [];
  const extras = Array.isArray(d.extras) ? d.extras as ExtraDetail[] : [];
  return {
    count: flags.length + extras.length,
    lines: [
      ...flags.map(f => `${f.partNumber ?? '—'}: ${t(boxCheckReasonKey(f.reason ?? ''))}`
        + (f.note ? ` (${f.note})` : '')),
      ...extras.map(x => t('bcExtraItem', { pn: x.partNumber ?? '' }) + (x.note ? ` (${x.note})` : '')),
    ],
  };
}
