// lib/fbOffer.ts: the only place an offer is computed (CONTRACTS §6.6 guard 2).
// Pure functions, plus marketFor against a real ref_prices row.

import { describe, it, expect, beforeAll } from 'vitest';
import { canonicalPartNumber, type FbMarketMatch } from '@recycle-erp/shared';
import { ceilingFor, marketFor, offerAmount, offerFor, partNumberCandidates } from '../src/lib/fbOffer';
import { getTestDb, resetDb } from './helpers/db';
import { CEILING, FIRST_OFFER, PN, agentInput, extractOf } from './helpers/fbAgent';

// A small seeded generator, so a failure names a case that reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('fbOffer', () => {
  it('ceiling is Σ max_buy_unit × qty and the first offer is opening_pct of it', () => {
    const r = offerFor(agentInput(), extractOf());
    expect(r).toEqual({ ok: true, offer_usd: FIRST_OFFER, ceiling_usd: CEILING, round: 1 });
  });

  it('climbs by step_pct a round and never passes the ceiling', () => {
    const p = { opening_pct: 70, step_pct: 10, max_rounds: 9, price_max_age_days: 30 };
    expect(offerAmount(1000, p, 1)).toBe(700);
    expect(offerAmount(1000, p, 2)).toBe(800);
    expect(offerAmount(1000, p, 4)).toBe(1000);
    expect(offerAmount(1000, p, 8)).toBe(1000);
    expect(offerAmount(99.5, { ...p, opening_pct: 100 }, 1)).toBe(99.5);
  });

  it('makes no offer without a quantity, a part number or an exact match', () => {
    const input = agentInput();
    expect(offerFor(input, extractOf({ items: [] }))).toMatchObject({ ok: false });
    expect(offerFor(input, extractOf({ items: [{ part_number: PN, description: '', qty: null }] })))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/No quantity/) });
    expect(offerFor(input, extractOf({ items: [{ part_number: null, description: 'ram', qty: 2 }] })))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/No part number/) });
    // One item matched and one not: no offer at all, not a partial one.
    expect(offerFor(input, extractOf({ items: [
      { part_number: PN, description: '', qty: 2 },
      { part_number: 'HMA84GR7AFR4N-VK', description: '', qty: 2 },
    ] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no exact Market match/) });
    const priceless = agentInput({ market: [{ ...agentInput().market[0]!, max_buy_unit: null }] });
    expect(offerFor(priceless, extractOf())).toMatchObject({ ok: false });
  });

  it('matches part numbers by their canonical form only', () => {
    const market: FbMarketMatch[] = [{ canon: canonicalPartNumber(PN), part_number: PN, label: '', max_buy_unit: 10, price_at: null }];
    expect(ceilingFor(market, [{ part_number: 'm393a4k40cb2 ctd', description: '', qty: 3 }])).toEqual({ ok: true, ceiling_usd: 30 });
    expect(ceilingFor(market, [{ part_number: 'M393A4K40CB2-CTE', description: '', qty: 3 }])).toMatchObject({ ok: false });
  });

  it('stops after max_rounds', () => {
    const input = agentInput({ thread: { ...agentInput().thread, round: 3, offer_usd: 270 } });
    expect(offerFor(input, extractOf())).toMatchObject({ ok: false, round: 4 });
  });

  it('property: no ask, round, quantity or ladder produces an offer above the ceiling', () => {
    const rand = rng(565);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (let i = 0; i < 2000; i++) {
      const items = Array.from({ length: int(1, 4) }, (_, k) => ({
        pn: `PART-${k}-${int(100, 999)}X`, qty: int(1, 500), unit: Math.round(rand() * 50000) / 100,
      }));
      const market: FbMarketMatch[] = items.map((it) => ({
        canon: canonicalPartNumber(it.pn), part_number: it.pn, label: '', max_buy_unit: it.unit, price_at: null,
      }));
      const settings = { opening_pct: int(1, 100), step_pct: int(1, 100), max_rounds: int(1, 12), price_max_age_days: 30 };
      const base = agentInput();
      const input = { ...base, market, settings, thread: { ...base.thread, round: int(0, 15) } };
      const ex = extractOf({
        items: items.map((it) => ({ part_number: it.pn, description: '', qty: it.qty })),
        seller_ask_usd: rand() < 0.5 ? null : Math.round(rand() * 1e6),
      });
      const r = offerFor(input, ex);
      const sum = items.reduce((s, it) => s + it.unit * it.qty, 0);
      if (!r.ok) continue;
      expect(r.ceiling_usd).toBeLessThanOrEqual(sum + 1e-9);
      expect(r.offer_usd).toBeLessThanOrEqual(r.ceiling_usd);
      expect(r.offer_usd).toBeGreaterThan(0);
      expect(r.round).toBeLessThanOrEqual(settings.max_rounds);
    }
  });

  it('collects part-number-looking tokens from what the seller wrote', () => {
    const got = partNumberCandidates([`I have 8 of ${PN} and two HMA84GR7AFR4N-VK, 32GB each, from an R740`]);
    expect(got).toContain(canonicalPartNumber(PN));
    expect(got).toContain(canonicalPartNumber('HMA84GR7AFR4N-VK'));
    expect(got).not.toContain('8');
  });
});

describe('marketFor', () => {
  beforeAll(async () => { await resetDb(); });

  it('reads the freshest exact match with the Market page max buy and its price date', async () => {
    const db = getTestDb();
    await db`
      INSERT INTO ref_prices (id, category, label, part_number, avg_sell, last_price, last_price_at, updated_at) VALUES
        ('fb-offer-old', 'RAM', 'Old row', ${PN}, 40, 45, '2026-10-01', '2026-10-01'),
        ('fb-offer-new', 'RAM', 'Samsung 32GB', ${PN.toLowerCase()}, 40, 50, '2026-11-01', '2026-11-01'),
        ('fb-offer-avg', 'RAM', 'Hynix 32GB', 'HMA84GR7AFR4N-VK', 30, NULL, NULL, '2026-11-02')`;
    const m = await marketFor(db, [PN, 'hma84gr7afr4n vk', 'NOPE-123']);
    const byCanon = new Map(m.map((r) => [r.canon, r]));
    const margin = 0.30; // the seeded target_margin
    expect(byCanon.get(canonicalPartNumber(PN))).toMatchObject({
      label: 'Samsung 32GB', max_buy_unit: +(50 * (1 - margin)).toFixed(2), price_at: new Date('2026-11-01').toISOString(),
    });
    expect(byCanon.get(canonicalPartNumber('HMA84GR7AFR4N-VK'))).toMatchObject({
      max_buy_unit: +(30 * (1 - margin)).toFixed(2), price_at: new Date('2026-11-02').toISOString(),
    });
    expect(m).toHaveLength(2);
  });
});
