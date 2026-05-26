// Multi-currency support module. USD is the reporting currency; CNY is the
// only foreign quote currency vendors can submit in. The DB stores rates as
// USD→quote (i.e. how many CNY per 1 USD); callers always work in the
// "multiplier to USD" direction (1/stored), so vendor amounts × rate = USD.
//
// Three sources, decreasing freshness wins via fetched_at: 'frankfurter'
// (the 6-hourly refresh loop), 'manual' (a manager override), and the
// implicit 'fixed' for USD itself. fetchAndStoreLatest is idempotent on
// (base, quote, effective_date) so the loop is safe to call repeatedly
// within the same UTC day.

import type { Sql, TransactionSql } from 'postgres';

type SqlLike = Sql<{}> | TransactionSql<{}>;

export const SUPPORTED_CURRENCIES = ['USD', 'CNY'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export interface FxLookup {
  /** Multiplier from quote currency to USD. USD is always 1. */
  rate: number;
  source: 'frankfurter' | 'manual' | 'fixed';
  fetchedAt: Date;
  effectiveDate: string; // ISO YYYY-MM-DD
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';

export function listSupportedCurrencies(): readonly SupportedCurrency[] {
  return SUPPORTED_CURRENCIES;
}

export function isSupportedCurrency(c: unknown): c is SupportedCurrency {
  return typeof c === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
}

export function convertToUsd(amount: number, rateToUsd: number): number {
  return Math.round(amount * rateToUsd * 100) / 100;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getLatestRateToUsd(
  sql: SqlLike,
  quote: SupportedCurrency,
): Promise<FxLookup> {
  if (quote === 'USD') {
    return { rate: 1, source: 'fixed', fetchedAt: new Date(), effectiveDate: todayIso() };
  }
  const rows = await sql<
    { rate: string; source: 'frankfurter' | 'manual'; fetched_at: Date; effective_date: Date }[]
  >`
    SELECT rate, source, fetched_at, effective_date
    FROM fx_rates
    WHERE base_currency = 'USD' AND quote_currency = ${quote}
    ORDER BY fetched_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return fetchAndStoreLatest(sql, quote);
  const stored = Number(rows[0].rate);
  return {
    rate: 1 / stored,
    source: rows[0].source,
    fetchedAt: rows[0].fetched_at,
    effectiveDate: toIsoDate(rows[0].effective_date),
  };
}

export async function fetchAndStoreLatest(
  sql: SqlLike,
  quote: SupportedCurrency,
): Promise<FxLookup> {
  if (quote === 'USD') return getLatestRateToUsd(sql, 'USD');
  const url = `${FRANKFURTER_URL}?base=USD&symbols=${quote}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const body = (await res.json()) as { amount: number; base: string; date: string; rates: Record<string, number> };
  const rate = body.rates?.[quote];
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`frankfurter returned invalid rate for ${quote}`);
  const effectiveDate = body.date;

  // Single-writer path (refresh loop + manual override). A SELECT-then-INSERT
  // is sufficient; the daily uniqueness invariant is by effective_date.
  const existing = await sql<{ rate: string; fetched_at: Date }[]>`
    SELECT rate, fetched_at FROM fx_rates
    WHERE base_currency = 'USD' AND quote_currency = ${quote} AND effective_date = ${effectiveDate}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return {
      rate: 1 / Number(existing[0].rate),
      source: 'frankfurter',
      fetchedAt: existing[0].fetched_at,
      effectiveDate,
    };
  }
  const inserted = await sql<{ fetched_at: Date }[]>`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date)
    VALUES ('USD', ${quote}, ${rate}, 'frankfurter', ${effectiveDate})
    RETURNING fetched_at
  `;
  return {
    rate: 1 / rate,
    source: 'frankfurter',
    fetchedAt: inserted[0].fetched_at,
    effectiveDate,
  };
}

export async function storeManualOverride(
  sql: Sql<{}>,
  quote: SupportedCurrency,
  rate: number,
  opts: { userId: string; note?: string },
): Promise<FxLookup> {
  if (quote === 'USD') throw new Error('manual override not allowed for USD');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('rate must be finite and positive');
  const effectiveDate = todayIso();
  const inserted = await sql<{ fetched_at: Date }[]>`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date, note, created_by)
    VALUES ('USD', ${quote}, ${rate}, 'manual', ${effectiveDate}, ${opts.note ?? null}, ${opts.userId})
    RETURNING fetched_at
  `;
  return {
    rate: 1 / rate,
    source: 'manual',
    fetchedAt: inserted[0].fetched_at,
    effectiveDate,
  };
}

export function startFxRefreshLoop(sql: Sql<{}>): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await fetchAndStoreLatest(sql, 'CNY');
    } catch (err) {
      console.warn('[fx] refresh failed; keeping previous row', err);
    }
  };
  void tick();
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}
