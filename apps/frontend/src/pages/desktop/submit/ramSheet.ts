import { canonicalPartNumber } from '@recycle-erp/shared';
import { ApiError } from '../../../lib/api';
import type { ScanResponse } from '../../../lib/types';
import { scanToLinePatch, type Line } from './line';

// Pure pieces of the "Scan RAM sheet" flow (RS-109): turning the per-stick
// scan results into PO lines, and pacing the per-stick /api/scan/label calls.
// The browser-only half (canvas crop) lives in lib/sheetImage.ts.

/** One reviewed stick, as the dialog hands it over. */
export type SheetRow = {
  scan: ScanResponse;
  qty: number;
  unitCost: string;
};

/**
 * Line patches for the rows the purchaser kept. With `combineByPn`, rows whose
 * part number and unit cost match become one line whose qty is the sum — a
 * sheet of eight identical DIMMs is one line of eight, not eight lines of one.
 * Rows without a part number are never combined (nothing says they're the
 * same part). The combined line keeps the first stick's scan image; the
 * others remain as label_scans rows only.
 */
export function buildRamLinePatches(
  rows: readonly SheetRow[],
  { combineByPn }: { combineByPn: boolean },
): Partial<Line>[] {
  const out: Array<Partial<Line>> = [];
  const byKey = new Map<string, Partial<Line>>();
  for (const r of rows) {
    const patch: Partial<Line> = {
      ...scanToLinePatch(r.scan, 'RAM'),
      qty: r.qty,
      unitCost: r.unitCost,
    };
    const pn = canonicalPartNumber(r.scan.extracted?.partNumber ?? '');
    const key = combineByPn && pn ? `${pn}|${Number(r.unitCost)}` : null;
    const seen = key ? byKey.get(key) : undefined;
    if (seen) {
      seen.qty = Number(seen.qty) + r.qty;
      continue;
    }
    if (key) byKey.set(key, patch);
    out.push(patch);
  }
  return out;
}

/** Runs async tasks with at most `limit` in flight, preserving result order. */
export async function runPool<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Retries `fn` while the backend answers 429. /api/scan/label allows 20 scans
 * a minute per user, so a sheet of more than 20 sticks slows down instead of
 * failing halfway. Any other error is thrown straight through.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = 6,
    waitMs = 10_000,
    sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  }: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 429) || i >= attempts) throw e;
      await sleep(waitMs);
    }
  }
}

/** Whether a line is still the untouched first line the form opens with. */
export function isPristineLine(l: Line): boolean {
  return !l._confirmed
    && !l._dbId
    && !l.scanImageId
    && !l.brand && !l.partNumber && !l.description
    && (l.qty === '' || l.qty == null)
    && (l.unitCost === '' || l.unitCost == null)
    && !(l.photos?.length);
}

/** Where the sheet flow is. `idle` = nothing started, `review` = all done. */
export type SheetStage = 'idle' | 'connect' | 'scan' | 'split' | 'read' | 'review';

/** The steps the dialog shows, in order. */
export const SHEET_STEPS = ['connect', 'scan', 'split', 'read'] as const;
export type SheetStep = (typeof SHEET_STEPS)[number];
export type StepState = 'pending' | 'active' | 'done' | 'error' | 'skipped';

/**
 * Each step's state for the step row. An uploaded image never touches the
 * printer, so its first two steps are `skipped` rather than falsely `done`.
 * `failedAt` marks the step that failed; work stops there.
 */
export function stepStates(
  stage: SheetStage,
  source: 'printer' | 'upload',
  failedAt?: SheetStep,
): Record<SheetStep, StepState> {
  const at = stage === 'idle' ? -1
    : stage === 'review' ? SHEET_STEPS.length
    : SHEET_STEPS.indexOf(stage);
  const out = {} as Record<SheetStep, StepState>;
  SHEET_STEPS.forEach((step, i) => {
    out[step] = source === 'upload' && (step === 'connect' || step === 'scan') ? 'skipped'
      : i < at ? 'done'
      : i > at ? 'pending'
      : failedAt === step ? 'error'
      : 'active';
  });
  return out;
}

/**
 * Whether a new scan read only part numbers an earlier scan already has —
 * almost always the same sheet scanned twice. Worth a warning because
 * combining identical part numbers would silently double the qty. Blank or
 * unread part numbers don't count either way.
 */
export function samePartsAsEarlier(newPns: readonly string[], earlierPns: readonly string[]): boolean {
  const earlier = new Set(earlierPns.map(canonicalPartNumber).filter(Boolean));
  const fresh = newPns.map(canonicalPartNumber).filter(Boolean);
  return earlier.size > 0 && fresh.length > 0 && fresh.every(pn => earlier.has(pn));
}
