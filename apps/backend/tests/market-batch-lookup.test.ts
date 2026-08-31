import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { PART_PREFIX_RE, PART_SEP_RE } from '../src/lib/part-number';

// The PO screens need a recorded value for a known set of part numbers in one
// round trip. GET /api/market only offers a substring search, which returns the
// wrong row whenever one PN is a prefix of another.

type LookupBody = {
  targetMargin: number;
  items: Record<string, { partNumber: string | null; maxBuy: number | null; avgSell: number | null; lastPrice: number | null }>;
};

async function seedRef(id: string, partNumber: string, opts: { avgSell?: number; lastPrice?: number; lastPriceAt?: string } = {}) {
  const db = getTestDb();
  await db`
    INSERT INTO ref_prices (id, category, label, part_number, avg_sell, last_price, last_price_at, updated_at)
    VALUES (${id}, 'RAM', ${'seed ' + id}, ${partNumber},
            ${opts.avgSell ?? 100}, ${opts.lastPrice ?? null},
            ${opts.lastPriceAt ?? null}, NOW())
  `;
}

describe('POST /api/market/lookup', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns a value keyed by the canonical part number', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-lookup-1', 'M393A4K40DB3-CWE', { avgSell: 80 });

    const r = await api<LookupBody>('POST', '/api/market/lookup', {
      token, body: { partNumbers: ['M393A4K40DB3-CWE'] },
    });
    expect(r.status).toBe(200);
    expect(r.body.items['M393A4K40DB3-CWE'].avgSell).toBe(80);
  });

  it('matches through a P/N prefix and interior whitespace', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-lookup-2', 'HMA84GR7CJR4N-WM', { avgSell: 42 });

    const r = await api<LookupBody>('POST', '/api/market/lookup', {
      token, body: { partNumbers: ['P/N: HMA84GR7 CJR4N-WM'] },
    });
    expect(r.status).toBe(200);
    // Answered under the string the caller asked with, whatever rule produced it.
    expect(r.body.items['P/N: HMA84GR7 CJR4N-WM'].avgSell).toBe(42);
  });

  it('matches a stored part number through any separator', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-lookup-sep', 'M393A4K40DB3-CWE', { avgSell: 55 });

    for (const asked of ['M393A4K40DB3 CWE', 'M393A4K40DB3_CWE', 'm393a4k40db3cwe']) {
      const r = await api<LookupBody>('POST', '/api/market/lookup', {
        token, body: { partNumbers: [asked] },
      });
      expect(r.status).toBe(200);
      expect(r.body.items[asked]?.avgSell, asked).toBe(55);
    }
  });

  // The Worker and Railway deploy apart, and a PWA tab outlives both. A client
  // bundled with the older rule asks under a key this server would never emit,
  // so the answer is keyed by what was asked, not by what this canonicalises to.
  it('answers under the key it was asked with, not its own', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-lookup-skew', 'SKEW-1', { avgSell: 12 });

    const r = await api<LookupBody>('POST', '/api/market/lookup', {
      token, body: { partNumbers: ['SKEW-1'] },   // what a pre-release client sends
    });
    expect(Object.keys(r.body.items)).toEqual(['SKEW-1']);
    expect(r.body.items['SKEW-1'].avgSell).toBe(12);
  });

  it('omits part numbers it has never recorded', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<LookupBody>('POST', '/api/market/lookup', {
      token, body: { partNumbers: ['NOT-A-REAL-PART'] },
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual({});
  });

  it('agrees with the list endpoint on maxBuy for the same row', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-lookup-3', 'AGREE-1', { avgSell: 200, lastPrice: 250, lastPriceAt: new Date().toISOString() });

    const one = await api<LookupBody>('POST', '/api/market/lookup', {
      token, body: { partNumbers: ['AGREE-1'] },
    });
    const list = await api<{ items: { partNumber: string | null; maxBuy: number | null }[] }>(
      'GET', '/api/market?q=AGREE-1', { token },
    );
    const fromList = list.body.items.find(i => i.partNumber === 'AGREE-1');
    expect(one.body.items['AGREE-1'].maxBuy).toBe(fromList?.maxBuy);
  });

  it('keeps the freshest row when two canonicalise the same', async () => {
    const { token } = await loginAs(ALEX);
    const old = new Date(Date.now() - 30 * 864e5).toISOString();
    const fresh = new Date().toISOString();
    await seedRef('rp-dup-old', 'DUP 1', { avgSell: 10, lastPrice: 11, lastPriceAt: old });
    await seedRef('rp-dup-new', 'DUP1', { avgSell: 99, lastPrice: 98, lastPriceAt: fresh });

    const r = await api<LookupBody>('POST', '/api/market/lookup', {
      token, body: { partNumbers: ['DUP1'] },
    });
    expect(r.body.items['DUP1'].lastPrice).toBe(98);
  });

  it('rejects an oversized batch', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/market/lookup', {
      token, body: { partNumbers: Array.from({ length: 101 }, (_, i) => 'PN-' + i) },
    });
    expect(r.status).toBe(413);
  });

  it('rejects a body without an array', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/market/lookup', { token, body: { partNumbers: 'nope' } });
    expect(r.status).toBe(400);
  });
});

// The index expression is hand-written SQL that has to mirror a TS constant.
// Nothing else would notice them drifting apart — the query keeps returning the
// right answer, it just silently stops using the index.
describe('ref_prices canonical part-number index', () => {
  beforeEach(async () => { await resetDb(); });

  it('indexes the same expression the canonicaliser produces', async () => {
    const db = getTestDb();
    const [row] = await db<{ def: string }[]>`
      SELECT pg_get_indexdef(oid) AS def FROM pg_class
      WHERE relname = 'ref_prices_canon_part_idx'
    `;
    expect(row, 'ref_prices_canon_part_idx is missing').toBeTruthy();
    // Postgres normalises whitespace in the stored definition, so compare on
    // the regex literal itself — the part that actually has to match.
    expect(row.def).toContain(PART_PREFIX_RE);
    expect(row.def).toContain(PART_SEP_RE);
    expect(row.def.toLowerCase()).toContain('upper');
  });

  // 0112 groups rows by an inlined copy of the same canon. The index assertion
  // above doesn't cover it, and a merge keyed on a stale rule would fold rows
  // runtime considers distinct — the one mistake in that file that cannot be
  // undone, since it deletes the losers.
  it('the per-category merge migration inlines the same canonicaliser', () => {
    const sqlText = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations',
           '0112_merge_duplicate_parts_per_category.sql'), 'utf8');
    expect(sqlText).toContain(PART_PREFIX_RE);
    expect(sqlText).toContain(PART_SEP_RE);
  });
});
