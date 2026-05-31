import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Dashboard = {
  role: string;
  recent: { user_id: string }[];
};

// A manager previewing as a purchaser (tweaks.rolePreview = 'as_purchaser')
// must see a dashboard scoped to their own work — same downgrade the orders
// list already applies via effectiveRole. The "Recent activity" panel is the
// PO-side ingest feed, so it must not surface other purchasers' POs.
describe('GET /api/dashboard manager rolePreview=as_purchaser scoping', () => {
  beforeEach(async () => { await resetDb(); });

  async function makeAdvancedPO(token: string): Promise<string> {
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    expect(created.status).toBe(201);
    const adv = await api('POST', `/api/orders/${created.body.id}/advance`, { token });
    expect(adv.status).toBe(200);
    return created.body.id;
  }

  it('preview hides other purchasers\' POs from recent activity and reports the effective role', async () => {
    const { user: marcus, token: marcusTok } = await loginAs(MARCUS);
    await makeAdvancedPO(marcusTok);

    const { token: alexTok } = await loginAs(ALEX);

    // Sanity: without preview a manager sees Marcus's just-ingested line.
    const asManager = await api<Dashboard>('GET', '/api/dashboard?range=90d', { token: alexTok });
    expect(asManager.status).toBe(200);
    expect(asManager.body.role).toBe('manager');
    expect(asManager.body.recent.some(r => r.user_id === marcus.id)).toBe(true);

    const setPref = await api('PATCH', '/api/me/preferences', {
      token: alexTok, body: { 'tweaks.rolePreview': 'as_purchaser' },
    });
    expect(setPref.status).toBe(200);

    const asPurchaser = await api<Dashboard>('GET', '/api/dashboard?range=90d', { token: alexTok });
    expect(asPurchaser.status).toBe(200);
    expect(asPurchaser.body.role).toBe('purchaser');
    expect(asPurchaser.body.recent.some(r => r.user_id === marcus.id)).toBe(false);
  });
});
