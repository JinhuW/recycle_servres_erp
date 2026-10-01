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
  // When this flag last went to the purchaser; editing the flag clears it.
  flagSentAt?: string | null;
};
export type CheckExtra = {
  id: string; partNumber: string; note: string | null; createdAt: string; sentAt?: string | null;
};
export type ChecksResponse = { lines: LineCheck[]; extras: CheckExtra[] };

export type CheckableLine = {
  id: string; qty: number; partNumber: string | null; serialNumber: string | null;
};

export type LineCheckState = 'open' | 'partial' | 'flagged' | 'done';

// Most lines arrive complete, so an untouched line reads as the full qty; the
// manager only lowers it when something is short. Checked is its own answer
// (checkedAt), never inferred from the count.
export function emptyCheck(lineId: string, qty: number): LineCheck {
  return { lineId, counted: qty, flagReason: null, flagNote: null, checkedAt: null };
}

export function countOf(line: CheckableLine, check: LineCheck | undefined): number {
  return Math.min(check?.counted ?? line.qty, line.qty);
}

// A flag outranks the tick: a line checked but flagged damaged still needs a
// decision, so it must not sink with the checked ones.  A tick only holds while
// the count still covers the line: a qty raised on the PO page after the tick
// puts units on the line that nobody counted.
export function lineState(line: CheckableLine, check: LineCheck | undefined): LineCheckState {
  if (check?.flagReason) return 'flagged';
  const short = (check?.counted ?? line.qty) < line.qty;
  if (check?.checkedAt && !short) return 'done';
  return short ? 'partial' : 'open';
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

// `counted` is the units on checked lines: with the count starting full, only
// a tick says anyone looked.
export function tally(lines: readonly CheckableLine[], checks: ReadonlyMap<string, LineCheck>): Tally {
  const t: Tally = { units: 0, counted: 0, open: 0, partial: 0, flagged: 0, done: 0 };
  for (const l of lines) {
    const c = checks.get(l.id);
    const s = lineState(l, c);
    t.units += l.qty;
    if (s === 'done') t.counted += countOf(l, c);
    t[s] += 1;
  }
  return t;
}

export type ScanMatch<L> = { line: L } | { ambiguous: string[] };

// Which same-part line a scan lands on: one still waiting first, so a flagged
// or short line can't swallow every scan of its part number.
const SCAN_RANK: Record<LineCheckState, number> = { open: 0, partial: 1, flagged: 2, done: 3 };

// A scanner types the label and presses Enter. Exact part number first, then
// a prefix (labels often carry a suffix the PO line doesn't), then a serial.
// A prefix that fits lines with different part numbers is a different SKU
// each — a speed grade, a revision — so it is handed back, not guessed.
export function matchScan<L extends CheckableLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>, raw: string,
): ScanMatch<L> | null {
  const q = canonicalPartNumber(raw);
  if (!q) return null;
  const pick = (hits: L[]): ScanMatch<L> | null => {
    const rank = (l: L) => SCAN_RANK[lineState(l, checks.get(l.id))];
    const best = hits.reduce<L | null>((b, l) => (b === null || rank(l) < rank(b) ? l : b), null);
    return best ? { line: best } : null;
  };
  const exact = lines.filter(l => canonicalPartNumber(l.partNumber) === q);
  if (exact.length) return pick(exact);
  if (q.length >= 6) {
    let prefix = lines.filter(l => {
      const pn = canonicalPartNumber(l.partNumber);
      return pn.length >= 6 && (q.startsWith(pn) || pn.startsWith(q));
    });
    // A label with a suffix names the most specific line it extends.
    const longest = Math.max(0, ...prefix
      .map(l => canonicalPartNumber(l.partNumber))
      .filter(pn => q.startsWith(pn))
      .map(pn => pn.length));
    if (longest) prefix = prefix.filter(l => canonicalPartNumber(l.partNumber).length === longest);
    const pns = new Map(prefix.map(l => [canonicalPartNumber(l.partNumber), l.partNumber ?? '']));
    if (pns.size > 1) return { ambiguous: [...pns.values()] };
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

// One body for every write, so a debounced save and a pre-approve flush can't
// disagree about whether the line is checked.  The count is clamped to the
// line's current qty: a qty lowered on the PO page after the count would
// otherwise make every later write of this line a 400.
export function checkBody(c: LineCheck, qty: number) {
  return {
    counted: Math.min(c.counted, qty), checked: c.checkedAt !== null,
    flagReason: c.flagReason, flagNote: c.flagNote,
  };
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
