import { isPricedSellPrice } from '@recycle-erp/shared';
import { poEffectiveCost } from './poTotals';
import type { ResolvedMarketValue } from './useMarketLookup';

// Review mode's pricing half: what the Market board suggests a line sells
// for, and what the purchaser earns once the lines are priced. Pure — the
// page owns the prices as typed, this decides what they add up to.

export type SellBasis = 'last' | 'avg' | 'internal';
export type SellSuggestion = { value: number; basis: SellBasis };

// The figure MarketAssist offers as "Suggested sell", in the same order: a
// recorded last price over a rolling average, and the team's own 30-day
// average only when the board has neither.
export function suggestedSell(m: ResolvedMarketValue | null | undefined): SellSuggestion | null {
  if (!m) return null;
  if (m.lastPrice != null && m.lastPrice > 0) return { value: m.lastPrice, basis: 'last' };
  if (m.avgSell != null && m.avgSell > 0) return { value: m.avgSell, basis: 'avg' };
  const internal = m.internalSales.samples > 0 ? m.internalSales.avgPrice : null;
  if (internal != null && internal > 0) return { value: internal, basis: 'internal' };
  return null;
}

export type PricedLine = { id: string; qty: number; unitCost: number; sellPrice: number | null };

export type ReviewMoneyInput = {
  lines: readonly PricedLine[];
  // The stored goods total: a negotiated lot price, or a mirror of the lines.
  totalCost: number | null;
  // The server's verdict on it; undefined falls back to judging locally.
  goodsFollowsLines?: boolean;
  otherFees: number;
  commissionRate: number | null;
  payment: 'company' | 'self';
  // Lines Approve will set to qty 0: no revenue, and no cost when the goods
  // total follows the lines.
  zeroed?: ReadonlySet<string>;
};

export type ReviewMoney = {
  priced: number;
  total: number;
  revenue: number;
  goods: number;
  fees: number;
  cost: number;
  profit: number;
  rate: number;
  commission: number;
  // What the purchaser is paid: the commission, plus the cost back on a
  // self-paid PO.
  earns: number;
  lotPrice: boolean;
};

// The Commission tab's formula, over the PO as Approve will leave it.
export function reviewMoney(o: ReviewMoneyInput): ReviewMoney {
  const zeroed = o.zeroed ?? new Set<string>();
  const qtyOf = (l: PricedLine) => (zeroed.has(l.id) ? 0 : l.qty);
  const savedSubtotal = o.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  const lineSubtotal = o.lines.reduce((s, l) => s + qtyOf(l) * l.unitCost, 0);
  // A pinned lot price stays whatever the count; a mirror follows the lines.
  const lotPrice = o.goodsFollowsLines !== undefined
    ? !o.goodsFollowsLines
    : o.totalCost != null && Math.round(o.totalCost * 100) !== Math.round(savedSubtotal * 100);
  const cost = poEffectiveCost({
    lineSubtotal,
    totalCostOverride: lotPrice ? o.totalCost : null,
    otherFees: o.otherFees,
  });
  let priced = 0;
  let total = 0;
  let revenue = 0;
  for (const l of o.lines) {
    total += 1;
    if (!isPricedSellPrice(l.sellPrice)) continue;
    priced += 1;
    revenue += qtyOf(l) * (l.sellPrice as number);
  }
  const rate = o.commissionRate ?? 0;
  const profit = revenue - cost.total;
  const commission = profit * rate;
  return {
    priced, total, revenue,
    goods: cost.goods, fees: cost.fees, cost: cost.total,
    profit, rate, commission,
    earns: (o.payment === 'self' ? cost.total : 0) + commission,
    lotPrice,
  };
}

// The margin a priced line carries, as the inventory editor states it:
// (sell − cost) / sell. Null while unpriced.
export function lineMargin(sellPrice: number | null | undefined, unitCost: number): number | null {
  if (!isPricedSellPrice(sellPrice)) return null;
  const sp = sellPrice as number;
  return (sp - unitCost) / sp;
}

// ── A sell order sheet read against the PO. The server matches each line
// by part number; what a match would do is decided here, against the prices
// as the page holds them now, so a price typed after the sheet was read is
// judged against the sheet too.

export type SheetCell = {
  sheet: string;
  rowNumber: number;
  rawPrice: string;
  currency: string;
  // US dollars; null when the row has no usable price.
  price: number | null;
  // The yuan a converted price came from.
  listedPrice?: number;
};

export type SheetLineMatch =
  | { lineId: string; status: 'matched'; cell: SheetCell }
  | { lineId: string; status: 'not-in-sheet' }
  | { lineId: string; status: 'no-part' }
  | { lineId: string; status: 'no-price' | 'invalid-price' | 'other-currency'; cell: SheetCell }
  | { lineId: string; status: 'conflict'; cells: SheetCell[] };

export type SheetSkip = Exclude<SheetLineMatch, { status: 'matched' | 'not-in-sheet' }>;

export type SheetPreview = {
  fx: { oneUsdInQuote: number; source: string } | null;
  lines: SheetLineMatch[];
  // Sheet rows whose part is on no line of the PO.
  notOnPo: number;
};

export type SheetRowPlan =
  // Lands on an unpriced line.
  | { kind: 'in'; price: number; cell: SheetCell }
  // Replaces a different price: the sheet wins unless the row is kept.
  | { kind: 'diff'; price: number; was: number; cell: SheetCell }
  | { kind: 'kept'; price: number; was: number; cell: SheetCell }
  | { kind: 'same'; cell: SheetCell }
  | { kind: 'off' }
  | { kind: 'skip'; match: SheetSkip };

export type SheetPlan = {
  rows: Map<string, SheetRowPlan>;
  writes: { lineId: string; price: number }[];
  // Of the writes, those that land on an unpriced line.
  incoming: number;
  repriced: number;
  unchanged: number;
  kept: number;
  notInSheet: number;
  // Lines the sheet names but cannot price.
  unmatched: number;
  notOnPo: number;
};

const toCents = (n: number) => Math.round(n * 100);

export function planSheet(
  lines: readonly { id: string; sellPrice: number | null }[],
  preview: SheetPreview,
  kept: ReadonlySet<string>,
): SheetPlan {
  const matchOf = new Map(preview.lines.map(m => [m.lineId, m]));
  const plan: SheetPlan = {
    rows: new Map(), writes: [], incoming: 0, repriced: 0, unchanged: 0, kept: 0,
    notInSheet: 0, unmatched: 0, notOnPo: preview.notOnPo,
  };
  for (const l of lines) {
    // A line added since the sheet was read has no match; it stays as it is.
    const m = matchOf.get(l.id);
    if (!m) continue;
    let row: SheetRowPlan;
    if (m.status === 'not-in-sheet') {
      row = { kind: 'off' };
      plan.notInSheet += 1;
    } else if (m.status !== 'matched') {
      row = { kind: 'skip', match: m };
      plan.unmatched += 1;
    } else {
      const price = m.cell.price as number;
      const was = isPricedSellPrice(l.sellPrice) ? l.sellPrice as number : null;
      if (was === null) {
        row = { kind: 'in', price, cell: m.cell };
        plan.writes.push({ lineId: l.id, price });
        plan.incoming += 1;
      } else if (toCents(was) === toCents(price)) {
        row = { kind: 'same', cell: m.cell };
        plan.unchanged += 1;
      } else if (kept.has(l.id)) {
        row = { kind: 'kept', price, was, cell: m.cell };
        plan.kept += 1;
      } else {
        row = { kind: 'diff', price, was, cell: m.cell };
        plan.writes.push({ lineId: l.id, price });
        plan.repriced += 1;
      }
    }
    plan.rows.set(l.id, row);
  }
  return plan;
}

// What a typed price means: blank clears, anything else must be a number of
// 0 or more (0 is how a line is unpriced, shared/sellPrice). Undefined is a
// value the field refuses to save. A comma counts only as a thousands
// separator (1,250.00): anywhere else it may be a decimal comma, and reading
// 12,50 as 1250 would price the line a hundred times over.
export function parsePriceInput(raw: string): number | null | undefined {
  const s = raw.trim().replace(/^\$/, '');
  if (s === '') return null;
  if (s.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return undefined;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}
