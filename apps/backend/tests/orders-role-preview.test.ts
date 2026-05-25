import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type OrderSummary = { id: string; userId: string; lifecycle: string };

// When a manager has tweaks.rolePreview = 'as_purchaser' they're previewing
// the system as if they were a purchaser; the backend must scope reads to
// their own POs so the FE preview and BE authority don't disagree. Setting
// the preference back to 'actual' restores manager visibility.
describe('GET /api/orders manager rolePreview=as_purchaser scoping', () => {
  beforeEach(async () => { await resetDb(); });

  async function makeAdvancedPO(token: string): Promise<string> {
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    expect(created.status).toBe(201);
    const adv = await api('POST', `/api/orders/${created.body.id}/advance`, { token });
    expect(adv.status).toBe(200);
    return created.body.id;
  }

  it('manager sees other purchasers\' POs by default (rolePreview=actual)', async () => {
    const { token: marcusTok } = await loginAs(MARCUS);
    const marcusPo = await makeAdvancedPO(marcusTok);

    const { token: priyaTok } = await loginAs(PRIYA);
    const priyaPo = await makeAdvancedPO(priyaTok);

    const { token: alexTok } = await loginAs(ALEX);
    const list = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: alexTok });
    expect(list.status).toBe(200);
    const ids = list.body.orders.map(o => o.id);
    expect(ids).toContain(marcusPo);
    expect(ids).toContain(priyaPo);
  });

  it('manager in as_purchaser preview is scoped to own POs and 403s on others', async () => {
    const { token: marcusTok } = await loginAs(MARCUS);
    const marcusPo = await makeAdvancedPO(marcusTok);

    const { token: alexTok } = await loginAs(ALEX);
    const setPref = await api('PATCH', '/api/me/preferences', {
      token: alexTok,
      body: { 'tweaks.rolePreview': 'as_purchaser' },
    });
    expect(setPref.status).toBe(200);

    const list = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: alexTok });
    expect(list.status).toBe(200);
    expect(list.body.orders.find(o => o.id === marcusPo)).toBeUndefined();
    expect(list.body.orders.every(o => o.userId !== undefined)).toBe(true);

    const detail = await api('GET', `/api/orders/${marcusPo}`, { token: alexTok });
    expect(detail.status).toBe(403);

    const events = await api('GET', `/api/orders/${marcusPo}/events`, { token: alexTok });
    expect(events.status).toBe(403);
  });

  it('reverting rolePreview to actual restores full manager visibility', async () => {
    const { token: marcusTok } = await loginAs(MARCUS);
    const marcusPo = await makeAdvancedPO(marcusTok);

    const { token: alexTok } = await loginAs(ALEX);
    await api('PATCH', '/api/me/preferences', {
      token: alexTok, body: { 'tweaks.rolePreview': 'as_purchaser' },
    });
    await api('PATCH', '/api/me/preferences', {
      token: alexTok, body: { 'tweaks.rolePreview': 'actual' },
    });

    const list = await api<{ orders: OrderSummary[] }>('GET', '/api/orders', { token: alexTok });
    expect(list.body.orders.find(o => o.id === marcusPo)).toBeDefined();

    const detail = await api('GET', `/api/orders/${marcusPo}`, { token: alexTok });
    expect(detail.status).toBe(200);
  });
});
