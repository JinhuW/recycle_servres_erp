import { Hono } from 'hono';
import { getDb } from '../db';
import {
  fetchAndStoreLatest,
  getLatestRateToUsd,
  isSupportedCurrency,
  storeManualOverride,
  SUPPORTED_CURRENCIES,
} from '../lib/fx';
import type { Env, User } from '../types';

// Manager-only HTTP surface over the fx_rates ledger. The DB stores
// USD→quote rates (multiplier-to-USD = 1/stored). The UI wants the
// "1 USD = N CNY" direction so we invert at the boundary.

const fxRates = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type HistoryRow = {
  id: string;
  quote_currency: string;
  rate: number;
  source: string;
  fetched_at: Date;
  effective_date: Date | string;
  note: string | null;
};

fxRates.get('/fx-rates', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  const latest: Record<string, { rate: number; source: string; fetchedAt: string; effectiveDate: string }> = {};
  for (const quote of SUPPORTED_CURRENCIES) {
    if (quote === 'USD') continue;
    const lookup = await getLatestRateToUsd(sql, quote);
    latest[quote] = {
      rate: 1 / lookup.rate,
      source: lookup.source,
      fetchedAt: lookup.fetchedAt.toISOString(),
      effectiveDate: lookup.effectiveDate,
    };
  }

  const history = await sql<HistoryRow[]>`
    SELECT id, quote_currency, rate::float AS rate, source, fetched_at, effective_date, note
    FROM fx_rates
    ORDER BY fetched_at DESC
    LIMIT 20
  `;

  return c.json({ latest, history });
});

fxRates.post('/fx-rates', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { quote?: unknown; rate?: unknown; note?: unknown }
    | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const { quote, rate, note } = body;

  if (!isSupportedCurrency(quote) || quote === 'USD') {
    return c.json({ error: 'quote must be a supported non-USD currency' }, 400);
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return c.json({ error: 'rate must be > 0' }, 400);
  }

  const sql = getDb(c.env);
  const r = await storeManualOverride(sql, quote, rate, {
    userId: c.var.user.id,
    note: typeof note === 'string' ? note : undefined,
  });
  return c.json(
    {
      rate: 1 / r.rate,
      source: r.source,
      fetchedAt: r.fetchedAt.toISOString(),
      effectiveDate: r.effectiveDate,
    },
    201,
  );
});

fxRates.post('/fx-rates/refresh', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const r = await fetchAndStoreLatest(sql, 'CNY');
  return c.json({
    rate: 1 / r.rate,
    source: r.source,
    fetchedAt: r.fetchedAt.toISOString(),
    effectiveDate: r.effectiveDate,
  });
});

export { fxRates };
export default fxRates;
