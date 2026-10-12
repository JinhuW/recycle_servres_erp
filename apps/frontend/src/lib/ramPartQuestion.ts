import {
  canonicalPartNumber, decodeRamPart, ramPartMismatches, ramPartReadingsMatching,
  type RamPartDecode, type RamPartField, type RamPartMismatch, type RamPartSpec,
} from '@recycle-erp/shared';

// The "specs don't match the part #" question, as a rule every save of a RAM
// line shares: the drawer's Confirm, Submit, Save, a scanned sheet's auto-save
// and the inventory editor. RamPartMismatchDialog is how it is asked.

export type RamPartLine = Partial<Record<RamPartField | 'partNumber' | 'category', string | null | undefined>>;

/**
 * A line as the question reads it. `_partKept` is what "keep as entered" let
 * stand. It is client state, so a line loaded from the server is seeded with
 * the disagreements it was saved with: those were the last save's to ask.
 */
export type PartQuestionLine = RamPartLine & { _partKept?: string | null };

/** The decode, its disagreements with the line, and readings that would agree. */
export function ramPartCheck(line: RamPartLine): {
  decode: RamPartDecode | null;
  mismatches: RamPartMismatch[];
  readings: string[];
} {
  if (line.category !== 'RAM') return { decode: null, mismatches: [], readings: [] };
  const decode = decodeRamPart(line.partNumber);
  const mismatches = ramPartMismatches(decode, line);
  const readings = mismatches.length ? ramPartReadingsMatching(line.partNumber, line) : [];
  return { decode, mismatches, readings };
}

/** The patch that makes the line agree with its part number. */
export function ramPartPatch(mismatches: RamPartMismatch[]): RamPartSpec {
  return Object.fromEntries(mismatches.map(m => [m.field, m.partSays]));
}

// One entry per disagreement, so keeping covers each one shown and nothing
// else: a fix to one of them doesn't reopen the rest, a new one asks.
const SEP = '\n';
const entries = (line: RamPartLine, mismatches: RamPartMismatch[]): string[] => {
  const pn = canonicalPartNumber(line.partNumber);
  return mismatches.map(m => `${pn}|${m.field}=${m.lineSays}`);
};

/** What keeping the line as entered records; null when it agrees with its part #. */
export function partQuestionKey(line: RamPartLine): string | null {
  const { mismatches } = ramPartCheck(line);
  return mismatches.length ? entries(line, mismatches).join(SEP) : null;
}

/** Whether saving the line has to ask: it disagrees in a way nobody let stand. */
export function partQuestionPending(line: PartQuestionLine): boolean {
  const { mismatches } = ramPartCheck(line);
  if (!mismatches.length) return false;
  const kept = new Set((line._partKept ?? '').split(SEP));
  return entries(line, mismatches).some(e => !kept.has(e));
}

export type PartAnswer =
  | { kind: 'use'; patch: RamPartSpec }
  | { kind: 'usePart'; partNumber: string }
  | { kind: 'keep' };

/** What an answer writes to the line it was asked about. */
export function partAnswerPatch(answer: PartAnswer, line: RamPartLine): PartQuestionLine {
  if (answer.kind === 'use') return answer.patch;
  if (answer.kind === 'usePart') return { partNumber: answer.partNumber };
  return { _partKept: partQuestionKey(line) };
}

/**
 * Asks until the line no longer has a disagreement to ask about — a fix to
 * one field can leave another in question, and that is asked in turn. Every
 * answer goes through `apply` as it is given, so it stands even if a later
 * question is cancelled. Null when one is.
 */
export async function settlePartQuestion<L extends PartQuestionLine>(
  line: L,
  ask: (line: L) => Promise<PartAnswer | null>,
  apply: (line: L, patch: Partial<L>) => L,
): Promise<L | null> {
  let cur = line;
  while (partQuestionPending(cur)) {
    const answer = await ask(cur);
    if (!answer) return null;
    cur = apply(cur, partAnswerPatch(answer, cur) as Partial<L>);
  }
  return cur;
}

/**
 * settlePartQuestion over the lines a save writes, in order; `asks` leaves out
 * the ones already answered for elsewhere. A cancel ends the asking: that
 * line and every later one still in question come back in `unsettled`, and
 * whether that stops the save or only holds them back is the caller's call.
 */
export async function settlePartQuestions<L extends PartQuestionLine>(
  lines: readonly L[],
  ask: (line: L, index: number) => Promise<PartAnswer | null>,
  apply: (line: L, patch: Partial<L>) => L,
  asks: (line: L) => boolean = () => true,
): Promise<{ lines: L[]; unsettled: number[] }> {
  const out = [...lines];
  const unsettled: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (!asks(out[i]) || !partQuestionPending(out[i])) continue;
    const settled = unsettled.length ? null : await settlePartQuestion(out[i], l => ask(l, i), apply);
    if (settled) out[i] = settled;
    else unsettled.push(i);
  }
  return { lines: out, unsettled };
}
