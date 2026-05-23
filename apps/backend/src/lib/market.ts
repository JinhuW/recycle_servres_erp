// Shared row→DTO mapping for the Market Value surface. The HTTP route and
// MCP tool both go through formatRefPrice so their payloads stay aligned.

export type MarketValueRow = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  part_number: string | null;
  label: string;
  sub_label: string | null;
  target: number | null;
  low_price: number | null;
  high_price: number | null;
  avg_sell: number | null;
  trend: number | null;
  samples: number | null;
  source: string | null;
  stock: number | null;
  demand: number | null;
  history: unknown;
  updated_at: Date;
  health: number | null;
  rpm: number | null;
  internal_avg: number | null;
  internal_samples: number | null;
  last_price: number | null;
  last_price_at: Date | null;
  last_price_source: string | null;
  recent_prices: { ts: string; price: number }[] | null;
};

export type MarketValue = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  formFactor: string | null;
  description: string | null;
  partNumber: string | null;
  label: string;
  sub: string | null;
  target: number | null;
  low: number | null;
  high: number | null;
  avgSell: number | null;
  trend: number | null;
  samples: number | null;
  source: string | null;
  stock: number | null;
  demand: number | null;
  history: unknown;
  updatedAt: string;
  maxBuy: number | null;
  health: number | null;
  rpm: number | null;
  // 30-day rolling aggregate of order_lines.sell_price (the purchaser's
  // projected sell price set at PO intake) for parts matching this row's
  // canonical part_number. The "Internal sales (last 30d)" price-source row
  // on the Market Value page renders this directly instead of the synthetic
  // offset used for external broker placeholders.
  internalSales: { avgPrice: number | null; samples: number };
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastPriceSource: string | null;
  recentPrices: { ts: string; price: number }[];
};

export function formatRefPrice(r: MarketValueRow, targetMargin: number): MarketValue {
  // maxBuy migrates to last_price as the basis (more meaningful with few
  // samples). Falls back to avg_sell when no recorded last_price yet — same
  // numeric behaviour as before for un-touched rows.
  const basis = r.last_price ?? r.avg_sell;
  return {
    id: r.id,
    category: r.category,
    brand: r.brand,
    capacity: r.capacity,
    type: r.type,
    classification: r.classification,
    rank: r.rank,
    speed: r.speed,
    interface: r.interface,
    formFactor: r.form_factor,
    description: r.description,
    partNumber: r.part_number,
    label: r.label,
    sub: r.sub_label,
    target: r.target,
    low: r.low_price,
    high: r.high_price,
    avgSell: r.avg_sell,
    trend: r.trend,
    samples: r.samples,
    source: r.source,
    stock: r.stock,
    demand: r.demand,
    history: r.history,
    updatedAt: r.updated_at.toISOString(),
    maxBuy: basis === null ? null : +(basis * (1 - targetMargin)).toFixed(2),
    health: r.health,
    rpm: r.rpm,
    internalSales: {
      avgPrice: r.internal_avg == null ? null : +r.internal_avg.toFixed(2),
      samples: r.internal_samples ?? 0,
    },
    lastPrice: r.last_price === null ? null : +r.last_price.toFixed(2),
    lastPriceAt: r.last_price_at ? r.last_price_at.toISOString() : null,
    lastPriceSource: r.last_price_source,
    recentPrices: r.recent_prices ?? [],
  };
}
