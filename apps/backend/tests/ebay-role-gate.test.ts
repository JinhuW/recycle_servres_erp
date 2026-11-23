import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, EBAY, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { restrictScopesToRole } from '../src/oauth/tokens';

// The eBay operator is denied by default in authMiddleware, so this samples
// the routes that check no role at all as well as the manager-only ones.
const DENIED: [string, string][] = [
  ['GET', '/api/orders'],
  ['GET', '/api/inventory'],
  ['GET', '/api/inventory/products'],
  ['GET', '/api/sell-orders'],
  ['GET', '/api/sell-orders/sellable'],
  ['GET', '/api/dashboard'],
  ['GET', '/api/home'],
  ['GET', '/api/market'],
  ['GET', '/api/market/parts'],
  ['GET', '/api/accounting/entries'],
  ['GET', '/api/leads/reddit'],
  ['GET', '/api/customers'],
  ['GET', '/api/suppliers'],
  ['GET', '/api/packages'],
  ['GET', '/api/after-sales'],
  ['GET', '/api/actions'],
  ['GET', '/api/activity'],
  ['GET', '/api/members'],
  ['GET', '/api/workspace/fx-rates'],
  ['GET', '/api/tracker/workers'],
  ['GET', '/api/coordinator/fleet'],
  ['GET', '/api/facebook-pool/accounts'],
  ['GET', '/api/fleet/hosts'],
  ['GET', '/api/ai/models'],
  ['GET', '/api/bank-transactions'],
  ['GET', '/api/oauth/clients'],
  ['POST', '/api/scan/label'],
  ['PATCH', '/api/workspace'],
];

const ALLOWED: string[] = [
  '/api/ebay/listings', '/api/ebay/sales', '/api/me', '/api/lookups', '/api/workspace',
  '/api/members/names', '/api/notifications', '/api/warehouses',
];

describe('eBay role gate', () => {
  beforeEach(async () => { await resetDb(); });

  it('the eBay operator reaches the eBay desk and the app shell, nothing else', async () => {
    const { token, user } = await loginAs(EBAY);
    expect(user.role).toBe('ebay');
    for (const [method, path] of DENIED) {
      const r = await api(method as 'GET', path, { token, body: method === 'GET' ? undefined : {} });
      expect([path, r.status]).toEqual([path, 403]);
    }
    for (const path of ALLOWED) {
      const r = await api('GET', path, { token });
      expect([path, r.status]).toEqual([path, 200]);
    }
    const pref = await api('PATCH', '/api/me/preferences', { token, body: { 'tweaks.density': 'compact' } });
    expect(pref.status).not.toBe(403);
  });

  it("the operator's listing JSON carries no cost, supplier or purchaser", async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    expect((await api('POST', '/api/ebay/listings', {
      token, body: { inventoryId: line.id, listings: [{ qty: 1, listPrice: 50 }] },
    })).status).toBe(201);
    const { token: op } = await loginAs(EBAY);
    const r = await api<{ rows: Record<string, unknown>[] }>('GET', '/api/ebay/listings', { token: op });
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(1);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/cost|supplier|purchaser|commission|user_name|userName/i);
    expect(text).not.toContain(String(line.unit_cost));
  });

  it('a purchaser gets nothing from the eBay desk', async () => {
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/ebay/listings', { token })).status).toBe(403);
    expect((await api('POST', '/api/ebay/listings', { token, body: {} })).status).toBe(403);
    expect((await api('POST', '/api/ebay/listings/EB-1/end', { token, body: { reason: 'no_buyer' } })).status).toBe(403);
    expect((await api('POST', '/api/ebay/listings/EB-1/sales', { token, body: {} })).status).toBe(403);
  });

  it('a manager creates an eBay member, who signs in to the eBay role', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ id: string; password: string }>('POST', '/api/members', {
      token, body: { email: 'seller@recycleservers.io', name: 'Eb Seller', role: 'ebay', password: 'a-long-password-1' },
    });
    expect(r.status).toBe(201);
    const { user, token: op } = await loginAs('seller@recycleservers.io', 'a-long-password-1');
    expect(user.role).toBe('ebay');
    expect((await api('GET', '/api/orders', { token: op })).status).toBe(403);
    expect((await api('GET', '/api/ebay/listings', { token: op })).status).toBe(200);
  });

  it('OAuth grants the eBay role no scopes', () => {
    expect(restrictScopesToRole(['market:read', 'orders:read'], 'ebay')).toEqual([]);
    expect(restrictScopesToRole(['market:read', 'orders:read'], 'purchaser')).toEqual(['market:read']);
  });
});
