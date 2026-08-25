import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS, PRIYA } from './helpers/auth';

const LINES = {
  lines: [{ category: 'HDD', qty: 1, unitCost: 10, condition: 'New' }],
};

describe('POST /api/orders onBehalfOfUserId', () => {
  beforeEach(async () => { await resetDb(); });

  it('lets a manager create an order owned by a purchaser, keeping the manager as actor', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const r = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token,
      body: { ...LINES, onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(201);

    const got = await api<{ order: { userId: string } }>(
      'GET', '/api/orders/' + r.body.id, { token: alex.token },
    );
    expect(got.body.order.userId).toBe(marcus.user.id);

    const ev = await api<{ events: {
      kind: string;
      actor: { id: string } | null;
      detail: { onBehalfOfUserId?: string; onBehalfOfName?: string };
    }[] }>(
      'GET', `/api/orders/${r.body.id}/events`, { token: alex.token },
    );
    const created = ev.body.events.find(e => e.kind === 'created');
    expect(created?.actor?.id).toBe(alex.user.id);
    expect(created?.detail.onBehalfOfUserId).toBe(marcus.user.id);
    expect(created?.detail.onBehalfOfName).toBe('Marcus Wright');
  });

  it('rejects a purchaser trying to create on behalf of someone else', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);

    const r = await api<{ error: string }>('POST', '/api/orders', {
      token: marcus.token,
      body: { ...LINES, onBehalfOfUserId: priya.user.id },
    });
    expect(r.status).toBe(403);
  });

  it('rejects a target that is not a purchaser', async () => {
    const alex = await loginAs(ALEX);
    const sofia = await loginAs(SOFIA);

    const r = await api<{ error: string }>('POST', '/api/orders', {
      token: alex.token,
      body: { ...LINES, onBehalfOfUserId: sofia.user.id },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/purchaser/i);
  });

  it('rejects an unknown target user', async () => {
    const alex = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', '/api/orders', {
      token: alex.token,
      body: { ...LINES, onBehalfOfUserId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status).toBe(400);
  });

  it('rejects a malformed id as a 400, not a uuid-cast 500', async () => {
    const alex = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', '/api/orders', {
      token: alex.token,
      body: { ...LINES, onBehalfOfUserId: 'marcus' },
    });
    expect(r.status).toBe(400);
  });
});

describe('warehouseId boundary check on every write path', () => {
  beforeEach(async () => { await resetDb(); });

  // The label wizard once sent "" and got an FK 500; /draft was fixed —
  // these pin the same guard on the sibling endpoints.
  it('POST /api/orders rejects an unknown warehouse as 400', async () => {
    const alex = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', '/api/orders', {
      token: alex.token,
      body: { ...LINES, warehouseId: '' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/warehouse/i);
  });

  it('PATCH /api/orders/:id rejects an unknown warehouse as 400 and null still clears', async () => {
    const alex = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES },
    });
    expect(created.status).toBe(201);

    const bad = await api<{ error: string }>('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { warehouseId: '' },
    });
    expect(bad.status).toBe(400);

    const clear = await api('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { warehouseId: null },
    });
    expect(clear.status).toBe(200);
  });
});

describe('PATCH /api/orders/:id onBehalfOfUserId — owner reassignment', () => {
  beforeEach(async () => { await resetDb(); });

  it('lets a manager reassign a draft to a purchaser and writes an owner_changed event', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES },
    });
    expect(created.status).toBe(201);

    const r = await api('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(200);

    const got = await api<{ order: { userId: string } }>(
      'GET', '/api/orders/' + created.body.id, { token: alex.token },
    );
    expect(got.body.order.userId).toBe(marcus.user.id);

    const ev = await api<{ events: {
      kind: string;
      actor: { id: string } | null;
      detail: { from?: string; to?: string; fromUserId?: string; toUserId?: string };
    }[] }>('GET', `/api/orders/${created.body.id}/events`, { token: alex.token });
    const changed = ev.body.events.find(e => e.kind === 'owner_changed');
    expect(changed?.actor?.id).toBe(alex.user.id);
    expect(changed?.detail.toUserId).toBe(marcus.user.id);
    expect(changed?.detail.to).toBe('Marcus Wright');
    expect(changed?.detail.fromUserId).toBe(alex.user.id);
  });

  it('works after submission (non-draft lifecycle)', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES },
    });
    const adv = await api('POST', `/api/orders/${created.body.id}/advance`, { token: alex.token });
    expect(adv.status).toBe(200);

    const r = await api('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(200);

    const got = await api<{ order: { userId: string } }>(
      'GET', '/api/orders/' + created.body.id, { token: alex.token },
    );
    expect(got.body.order.userId).toBe(marcus.user.id);
  });

  it('lets a manager take an order back from a purchaser', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES, onBehalfOfUserId: marcus.user.id },
    });
    const r = await api('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { onBehalfOfUserId: alex.user.id },
    });
    expect(r.status).toBe(200);

    const got = await api<{ order: { userId: string } }>(
      'GET', '/api/orders/' + created.body.id, { token: alex.token },
    );
    expect(got.body.order.userId).toBe(alex.user.id);
  });

  it('rejects a purchaser trying to reassign their own order', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: marcus.token, body: { ...LINES },
    });
    const r = await api<{ error: string }>('PATCH', `/api/orders/${created.body.id}`, {
      token: marcus.token, body: { onBehalfOfUserId: priya.user.id },
    });
    expect(r.status).toBe(403);
  });

  it('rejects a target that is not an active purchaser', async () => {
    const alex = await loginAs(ALEX);
    const sofia = await loginAs(SOFIA);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES },
    });
    const r = await api<{ error: string }>('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { onBehalfOfUserId: sofia.user.id },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/purchaser/i);
  });

  it('refuses to move ownership of a Done order', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES },
    });
    for (let i = 0; i < 3; i++) {
      const adv = await api('POST', `/api/orders/${created.body.id}/advance`, { token: alex.token });
      expect(adv.status).toBe(200);
    }
    const r = await api<{ error: string }>('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(409);
  });

  it('writes no event when the target already owns the order', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: alex.token, body: { ...LINES, onBehalfOfUserId: marcus.user.id },
    });
    const r = await api('PATCH', `/api/orders/${created.body.id}`, {
      token: alex.token, body: { onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(200);

    const ev = await api<{ events: { kind: string }[] }>(
      'GET', `/api/orders/${created.body.id}/events`, { token: alex.token },
    );
    expect(ev.body.events.filter(e => e.kind === 'owner_changed')).toHaveLength(0);
  });
});

describe('POST /api/orders/draft onBehalfOfUserId', () => {
  beforeEach(async () => { await resetDb(); });

  it('lets a manager start a draft owned by a purchaser', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);

    const r = await api<{ id: string }>('POST', '/api/orders/draft', {
      token: alex.token,
      body: { onBehalfOfUserId: marcus.user.id },
    });
    expect(r.status).toBe(201);

    const got = await api<{ order: { userId: string } }>(
      'GET', '/api/orders/' + r.body.id, { token: alex.token },
    );
    expect(got.body.order.userId).toBe(marcus.user.id);
  });

  it('rejects a purchaser trying to start a draft for someone else', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);

    const r = await api<{ error: string }>('POST', '/api/orders/draft', {
      token: marcus.token,
      body: { onBehalfOfUserId: priya.user.id },
    });
    expect(r.status).toBe(403);
  });
});
