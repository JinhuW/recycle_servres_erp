export type Tier = {
  id?: number;
  label: string;
  floorPct: number;  // 0..100
  rate: number;      // 0..100
};

export type CommissionInput = {
  profit: number;
  revenue: number;
  overrideRate?: number | null;
};

export type CommissionResult = {
  tier: Tier;
  rate: number;
  payable: number;
  marginPct: number;
};

export function computeCommission(input: CommissionInput, tiers: Tier[]): CommissionResult {
  const marginPct = input.revenue > 0 ? (input.profit / input.revenue) * 100 : 0;

  if (input.overrideRate != null) {
    return {
      tier: { label: 'Override', floorPct: 0, rate: input.overrideRate },
      rate: input.overrideRate,
      payable: +(input.profit * input.overrideRate / 100).toFixed(2),
      marginPct,
    };
  }
  const sorted = [...tiers].sort((a, b) => a.floorPct - b.floorPct);
  let chosen = sorted[0];
  for (const t of sorted) if (marginPct >= t.floorPct) chosen = t;
  return {
    tier: chosen,
    rate: chosen.rate,
    payable: +(input.profit * chosen.rate / 100).toFixed(2),
    marginPct,
  };
}
