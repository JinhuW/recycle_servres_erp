import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('GET /api/market — target margin', () => {
  beforeEach(async () => { await resetDb(); });

  it('uses the workspace-configured target_margin for maxBuy', async () => {
    const { token } = await loginAs(ALEX);

    const def = await api<{ targetMargin: number; items: { avgSell: number; maxBuy: number }[] }>(
      'GET', '/api/market', { token });
    expect(def.status).toBe(200);
    expect(def.body.targetMargin).toBe(0.30);

    const w = await api('PATCH', '/api/workspace', { token, body: { target_margin: 0.5 } });
    expect(w.status).toBe(200);

    const r = await api<{ targetMargin: number; items: { avgSell: number; maxBuy: number }[] }>(
      'GET', '/api/market', { token });
    expect(r.body.targetMargin).toBe(0.5);
    const row = r.body.items.find(i => i.avgSell > 0)!;
    expect(row.maxBuy).toBeCloseTo(+(row.avgSell * 0.5).toFixed(2), 2);
  });
});
