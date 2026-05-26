import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { getTestDb } from './helpers/db';
import { resetDb } from './helpers/db';
import {
  convertToUsd,
  fetchAndStoreLatest,
  getLatestRateToUsd,
  isSupportedCurrency,
  listSupportedCurrencies,
  storeManualOverride,
  SUPPORTED_CURRENCIES,
} from '../src/lib/fx';

// Capture Frankfurter requests so we can assert idempotency without a real
// network call. The project's existing pattern (see ai.test.ts) is
// vi.stubGlobal('fetch', …) rather than undici MockAgent.
function mockFrankfurter(rate: number, date = '2026-05-26') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ amount: 1, base: 'USD', date, rates: { CNY: rate } }), { status: 200 }),
    ),
  );
}

describe('fx pure helpers', () => {
  it('listSupportedCurrencies returns USD and CNY', () => {
    expect(listSupportedCurrencies()).toEqual(['USD', 'CNY']);
    expect(SUPPORTED_CURRENCIES).toContain('USD');
    expect(SUPPORTED_CURRENCIES).toContain('CNY');
  });

  it('isSupportedCurrency narrows to USD/CNY only', () => {
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('CNY')).toBe(true);
    expect(isSupportedCurrency('EUR')).toBe(false);
    expect(isSupportedCurrency(42)).toBe(false);
    expect(isSupportedCurrency(null)).toBe(false);
  });

  it('convertToUsd rounds to 2dp', () => {
    expect(convertToUsd(78, 1 / 7.2154)).toBeCloseTo(10.81, 2);
    expect(convertToUsd(123.45, 1)).toBe(123.45);
  });
});

describe('fx DB integration', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('USD lookup is fixed at 1 without touching the DB', async () => {
    const sql = getTestDb();
    const r = await getLatestRateToUsd(sql, 'USD');
    expect(r.rate).toBe(1);
    expect(r.source).toBe('fixed');
    const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM fx_rates`;
    expect(rows[0].count).toBe('0');
  });

  it('empty CNY lookup triggers Frankfurter fetch and stores', async () => {
    mockFrankfurter(7.2154);
    const sql = getTestDb();
    const r = await getLatestRateToUsd(sql, 'CNY');
    expect(r.source).toBe('frankfurter');
    expect(r.rate).toBeCloseTo(1 / 7.2154, 6);
    const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM fx_rates`;
    expect(rows[0].count).toBe('1');
  });

  it('fetchAndStoreLatest is idempotent on effective_date', async () => {
    const sql = getTestDb();
    mockFrankfurter(7.2154, '2026-05-26');
    const first = await fetchAndStoreLatest(sql, 'CNY');
    mockFrankfurter(7.2999, '2026-05-26'); // same date, different rate
    const second = await fetchAndStoreLatest(sql, 'CNY');
    expect(first.rate).toBeCloseTo(1 / 7.2154, 6);
    expect(second.rate).toBeCloseTo(1 / 7.2154, 6); // unchanged — no second insert
    const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM fx_rates`;
    expect(rows[0].count).toBe('1');
  });

  it('manual override beats older Frankfurter row', async () => {
    const sql = getTestDb();
    const users = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, initials, role, password_hash)
      VALUES ('fx@test', 'FX Tester', 'FT', 'manager', 'x')
      RETURNING id
    `;
    const userId = users[0].id;
    mockFrankfurter(7.2154);
    await fetchAndStoreLatest(sql, 'CNY');
    const manual = await storeManualOverride(sql, 'CNY', 7.0, { userId, note: 'pinned' });
    expect(manual.source).toBe('manual');
    expect(manual.rate).toBeCloseTo(1 / 7.0, 6);

    const r = await getLatestRateToUsd(sql, 'CNY');
    expect(r.source).toBe('manual');
    expect(r.rate).toBeCloseTo(1 / 7.0, 6);
  });
});
