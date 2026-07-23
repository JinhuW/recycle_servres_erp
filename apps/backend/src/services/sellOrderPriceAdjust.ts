// Proration engine for negotiated final-price adjustments.
//
// A bidder names one final total; we spread the delta across every line's
// unit price so the "total === sum of lines" invariant (migration 0036) holds
// and per-part market datapoints keep reflecting real sale prices. All
// arithmetic is in integer cents — unit prices are NUMERIC(12,2), so the
// smallest move on line i changes the total by qty_i cents. That granularity
// means the typed target may be unreachable exactly; the achieved total is
// authoritative and callers must surface it, never the requested value.

export interface ProrateLineIn {
  qty: number;
  /** Native-currency unit price, ≤ 2 decimals. */
  price: number;
}

export interface ProrateResult {
  /** New native unit prices, same order as the input lines. */
  prices: number[];
  /** Σ qty·price of the new set — may differ from the target by < min(qty) cents. */
  achievedTotal: number;
}

export type ProrateError =
  | 'target must be a positive amount with at most 2 decimals'
  | 'cannot adjust an order whose total is zero';

const toCents = (n: number): number => Math.round(n * 100);
const fromCents = (n: number): number => n / 100;

export function validateTarget(
  lines: ProrateLineIn[],
  targetTotal: number,
): ProrateError | null {
  // 2dp check tolerates float representation (9500.55 * 100 is 950054.999…).
  if (!Number.isFinite(targetTotal) || targetTotal <= 0
      || Math.abs(targetTotal * 100 - toCents(targetTotal)) > 1e-6) {
    return 'target must be a positive amount with at most 2 decimals';
  }
  const current = lines.reduce((a, l) => a + l.qty * toCents(l.price), 0);
  if (current === 0) return 'cannot adjust an order whose total is zero';
  return null;
}

export function prorateLines(
  lines: ProrateLineIn[],
  targetTotal: number,
): ProrateResult {
  const err = validateTarget(lines, targetTotal);
  if (err) throw new Error(err);

  const priceCents = lines.map(l => toCents(l.price));
  const currentCents = lines.reduce((a, l, i) => a + l.qty * priceCents[i], 0);
  const targetCents = toCents(targetTotal);
  const scale = targetCents / currentCents;

  // Floor pass keeps the running total at or under target, so the residual is
  // always non-negative and gets distributed upward. Zero-price lines scale to
  // zero and stay there — free items don't absorb negotiation deltas.
  const base = priceCents.map(p => Math.floor(p * scale));
  const remainders = priceCents.map((p, i) => p * scale - base[i]);
  let residual = targetCents - lines.reduce((a, l, i) => a + l.qty * base[i], 0);

  // Largest-remainder in unit-price cent steps: bumping line i by one cent
  // costs qty_i cents of total. Candidates are retried in remainder order
  // (index tie-break, so the result is deterministic) until no line's qty
  // still fits into the residual.
  const order = lines
    .map((_, i) => i)
    .filter(i => priceCents[i] > 0)
    .sort((a, b) => remainders[b] - remainders[a] || a - b);
  let progressed = true;
  while (residual > 0 && progressed) {
    progressed = false;
    for (const i of order) {
      if (lines[i].qty <= residual) {
        base[i] += 1;
        residual -= lines[i].qty;
        progressed = true;
      }
    }
  }

  const achieved = lines.reduce((a, l, i) => a + l.qty * base[i], 0);
  return { prices: base.map(fromCents), achievedTotal: fromCents(achieved) };
}
