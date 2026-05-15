import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { computeCommission, type Tier } from '../src/lib/commission-calc';

const TIERS: Tier[] = [
  { id: 1, label: 'Base',     floorPct: 0,  rate: 2 },
  { id: 2, label: 'Tier 1',   floorPct: 25, rate: 4 },
  { id: 3, label: 'Tier 2',   floorPct: 35, rate: 6 },
  { id: 4, label: 'Top',      floorPct: 45, rate: 9 },
];

describe('computeCommission (pure)', () => {
  it('Top tier when margin = 100%', () => {
    const r = computeCommission({ profit: 1000, revenue: 1000 }, TIERS);
    expect(r.tier.label).toBe('Top');
    expect(r.payable).toBe(90); // 9% of 1000
  });

  it('Tier 1 when margin 30%', () => {
    const r = computeCommission({ profit: 300, revenue: 1000 }, TIERS);
    expect(r.tier.label).toBe('Tier 1');
    expect(r.payable).toBe(12); // 4% of 300
  });

  it('zero revenue → 0 commission, Base tier', () => {
    const r = computeCommission({ profit: 0, revenue: 0 }, TIERS);
    expect(r.payable).toBe(0);
    expect(r.tier.label).toBe('Base');
  });

  it('overrideRate wins when supplied (per-user)', () => {
    const r = computeCommission({ profit: 1000, revenue: 1000, overrideRate: 7.5 }, TIERS);
    expect(r.payable).toBe(75);
    expect(r.tier.label).toBe('Override');
  });
});

describe('GET /api/commission/tiers', () => {
  beforeEach(async () => { await resetDb(); });

  it('both roles can read', async () => {
    for (const email of [ALEX, MARCUS]) {
      const { token } = await loginAs(email);
      const r = await api<{ tiers: Tier[] }>('GET', '/api/commission/tiers', { token });
      expect(r.status).toBe(200);
      expect(r.body.tiers.length).toBe(4);
    }
  });

  it('manager can PUT new tiers', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PUT', '/api/commission/tiers', {
      token, body: { tiers: [
        { label: 'Flat', floorPct: 0, rate: 5 },
      ] },
    });
    expect(r.status).toBe(200);
    const got = await api<{ tiers: Tier[] }>('GET', '/api/commission/tiers', { token });
    expect(got.body.tiers.length).toBe(1);
    expect(got.body.tiers[0].rate).toBe(5);
  });
});

describe('GET /api/commission/preview', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns matching tier', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ tier: { label: string }; payable: number }>(
      'GET', '/api/commission/preview?profit=5000&margin=0.35', { token });
    expect(r.status).toBe(200);
    expect(r.body.tier.label).toBe('Tier 2');
    expect(r.body.payable).toBe(300); // 5000 * 6%
  });
});
