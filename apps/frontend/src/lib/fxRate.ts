import { api } from './api';

// Current FX snapshot for one currency, in the directions the UI needs:
// `rateToUsd` multiplies a native amount to USD; `oneUsdInQuote` is the
// human "1 USD = N CNY" figure for rate notes. USD is the identity.
export type FxInfo = { rateToUsd: number; source: string; oneUsdInQuote: number };

// Reads the manager FX ledger (the same endpoint the Settings → FX panel uses),
// whose `latest[quote].rate` is the human USD→quote figure (CNY per 1 USD).
export async function fetchRateToUsd(currency: string): Promise<FxInfo> {
  if (currency === 'USD') return { rateToUsd: 1, source: 'fixed', oneUsdInQuote: 1 };
  const r = await api.get<{ latest: Record<string, { rate: number; source: string }> }>(
    '/api/workspace/fx-rates',
  );
  const row = r.latest[currency];
  if (!row || !(row.rate > 0)) throw new Error('rate unavailable');
  return { rateToUsd: 1 / row.rate, source: row.source, oneUsdInQuote: row.rate };
}
