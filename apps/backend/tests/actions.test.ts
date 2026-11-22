import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import type { ActionColumnOrder, ActionEvent, ActionItem, ActionLinkTarget } from '@recycle-erp/shared';

type Who = { token: string; id: string };
const who = async (email: string): Promise<Who> => {
  const r = await loginAs(email);
  return { token: r.token, id: r.user.id };
};

const create = (w: Who, body: Record<string, unknown>) =>
  api<{ item: ActionItem; error?: string }>('POST', '/api/actions', { token: w.token, body });
const board = async (w: Who, qs = '') =>
  (await api<{ items: ActionItem[] }>('GET', `/api/actions${qs}`, { token: w.token })).body.items;
const move = (w: Who, id: string, status: string, beforeId: string | null = null) =>
  api<{ order: ActionColumnOrder; error?: string }>('POST', `/api/actions/${id}/move`, {
    token: w.token, body: { status, beforeId },
  });
const column = (items: ActionItem[], status: string) =>
  items.filter(i => i.status === status).sort((a, b) => a.position - b.position).map(i => i.id);

async function poOwnedBy(userId: string): Promise<string> {
  const db = getTestDb();
  const [r] = await db<{ id: string }[]>`SELECT id FROM orders WHERE user_id = ${userId} ORDER BY id LIMIT 1`;
  expect(r, 'seed has a PO for this user').toBeDefined();
  return r.id;
}
async function clientOwnedBy(userId: string, name: string): Promise<string> {
  const db = getTestDb();
  const [r] = await db<{ id: string }[]>`
    INSERT INTO suppliers (name, owner_id) VALUES (${name}, ${userId}) RETURNING id
  `;
  return r.id;
}

describe('actions board', () => {
  beforeEach(async () => { await resetDb(); });

  it('needs a session', async () => {
    expect((await api('GET', '/api/actions', {})).status).toBe(401);
    expect((await api('GET', '/api/actions/mine', {})).status).toBe(401);
  });

  it('lets a purchaser create a card for a manager, and tells the assignee', async () => {
    const marcus = await who(MARCUS);
    const alex = await who(ALEX);
    const r = await create(marcus, { title: '  Chase the tracking  ', assigneeId: alex.id, priority: 'high', dueDate: '2026-12-01' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({
      title: 'Chase the tracking', status: 'todo', priority: 'high', dueDate: '2026-12-01',
      assignee: { id: alex.id }, createdBy: { id: marcus.id }, link: null, canRemove: true,
    });
    expect(r.body.item.id).toMatch(/^TK-\d+$/);

    const db = getTestDb();
    const notes = await db`SELECT title, body FROM notifications WHERE user_id = ${alex.id} AND kind = 'action_assigned'`;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('Chase the tracking');

    // Assigning to yourself is not news.
    await create(alex, { title: 'mine', assigneeId: alex.id });
    expect(await db`SELECT 1 FROM notifications WHERE user_id = ${alex.id} AND kind = 'action_assigned'`).toHaveLength(1);

    const mine = await api<{ count: number; items: ActionItem[] }>('GET', '/api/actions/mine', { token: alex.token });
    expect(mine.body.count).toBe(2);
    expect(mine.body.items[0].priority).toBe('high');
  });

  it('validates the body and refuses an inactive assignee', async () => {
    const alex = await who(ALEX);
    const priya = await who(PRIYA);
    expect((await create(alex, { title: '' })).status).toBe(400);
    expect((await create(alex, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await create(alex, { title: 'x', status: 'later' })).status).toBe(400);
    expect((await create(alex, { title: 'x', dueDate: '2026-02-30' })).status).toBe(400);
    expect((await create(alex, { title: 'x', link: { type: 'po', id: '' } })).status).toBe(400);
    await getTestDb()`UPDATE users SET active = FALSE WHERE id = ${priya.id}`;
    expect((await create(alex, { title: 'x', assigneeId: priya.id })).status).toBe(400);
  });

  it('edits, reassigns and comments, with a timeline of each', async () => {
    const alex = await who(ALEX);
    const marcus = await who(MARCUS);
    const priya = await who(PRIYA);
    const { body: { item } } = await create(alex, { title: 'Recount box 4', assigneeId: marcus.id });

    const p = await api<{ item: ActionItem }>('PATCH', `/api/actions/${item.id}`, {
      token: marcus.token, body: { title: 'Recount box 4 and 5', assigneeId: priya.id, dueDate: null },
    });
    expect(p.status).toBe(200);
    expect(p.body.item).toMatchObject({ title: 'Recount box 4 and 5', assignee: { id: priya.id } });

    expect((await api('POST', `/api/actions/${item.id}/notes`, { token: priya.token, body: { note: 'on it' } })).status).toBe(200);
    expect((await api('POST', `/api/actions/${item.id}/notes`, { token: priya.token, body: { note: '  ' } })).status).toBe(400);

    const d = await api<{ item: ActionItem; events: ActionEvent[] }>('GET', `/api/actions/${item.id}`, { token: alex.token });
    expect(d.body.item.noteCount).toBe(1);
    expect(d.body.events.map(e => e.kind)).toEqual(['created', 'edited', 'assigned', 'note']);
    expect(d.body.events[3]).toMatchObject({ note: 'on it', actor: { id: priya.id } });

    const db = getTestDb();
    expect(await db`SELECT 1 FROM notifications WHERE user_id = ${priya.id} AND kind = 'action_assigned'`).toHaveLength(1);
  });

  it('puts new cards on top and renumbers a column on every move', async () => {
    const alex = await who(ALEX);
    const a = (await create(alex, { title: 'a' })).body.item.id;
    const b = (await create(alex, { title: 'b' })).body.item.id;
    const c = (await create(alex, { title: 'c' })).body.item.id;
    expect(column(await board(alex), 'todo')).toEqual([c, b, a]);

    // Reorder inside the column: a above c.
    let r = await move(alex, a, 'todo', c);
    expect(r.body.order).toEqual({ todo: [a, c, b] });
    expect(column(await board(alex), 'todo')).toEqual([a, c, b]);

    // Across columns: c to the bottom of In progress, then b above it.
    r = await move(alex, c, 'in_progress');
    expect(r.body.order).toEqual({ in_progress: [c], todo: [a, b] });
    r = await move(alex, b, 'in_progress', c);
    expect(r.body.order).toEqual({ in_progress: [b, c], todo: [a] });

    // A beforeId that is no longer in the column lands at the bottom.
    r = await move(alex, a, 'in_progress', 'TK-999999');
    expect(r.body.order.in_progress).toEqual([b, c, a]);

    const items = await board(alex);
    expect(column(items, 'in_progress')).toEqual([b, c, a]);
    expect(items.map(i => i.position).sort()).toEqual([0, 1, 2]);

    const d = await api<{ events: ActionEvent[] }>('GET', `/api/actions/${c}`, { token: alex.token });
    expect(d.body.events.filter(e => e.kind === 'moved')).toHaveLength(1);
    expect((await move(alex, a, 'later')).status).toBe(400);
    expect((await move(alex, 'TK-1', 'done')).status).toBe(404);
  });

  it('stamps completion on Done and keeps Done cards on the board for 14 days', async () => {
    const alex = await who(ALEX);
    const id = (await create(alex, { title: 'ship it' })).body.item.id;
    await move(alex, id, 'done');
    let item = (await board(alex)).find(i => i.id === id)!;
    expect(item.completedAt).not.toBeNull();

    await move(alex, id, 'blocked');
    item = (await board(alex)).find(i => i.id === id)!;
    expect(item.completedAt).toBeNull();

    await move(alex, id, 'done');
    const db = getTestDb();
    await db`UPDATE action_items SET completed_at = NOW() - INTERVAL '15 days' WHERE id = ${id}`;
    expect((await board(alex)).find(i => i.id === id)).toBeUndefined();
    const arch = await api<{ items: ActionItem[]; nextCursor: string | null }>('GET', '/api/actions/archive', { token: alex.token });
    expect(arch.body.items.map(i => i.id)).toEqual([id]);
    expect(arch.body.nextCursor).toBeNull();
  });

  it('serialises concurrent moves instead of deadlocking', async () => {
    const alex = await who(ALEX);
    const marcus = await who(MARCUS);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await create(alex, { title: `card ${i}` })).body.item.id);
    for (const id of ids.slice(3)) await move(alex, id, 'done');

    const results = await Promise.all([
      ...ids.slice(0, 3).map(id => move(alex, id, 'done')),
      ...ids.slice(3).map(id => move(marcus, id, 'todo')),
    ]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const items = await board(alex);
    for (const s of ['todo', 'done']) {
      const pos = items.filter(i => i.status === s).map(i => i.position).sort((a, b) => a - b);
      expect(pos).toEqual([0, 1, 2]);
    }
  });

  it('shows a purchaser only what they could open of a linked record', async () => {
    const alex = await who(ALEX);
    const marcus = await who(MARCUS);
    const priya = await who(PRIYA);
    const db = getTestDb();
    const [so] = await db<{ id: string }[]>`SELECT id FROM sell_orders ORDER BY id LIMIT 1`;
    const marcusPo = await poOwnedBy(marcus.id);
    const priyaPo = await poOwnedBy(priya.id);
    const marcusClient = await clientOwnedBy(marcus.id, 'Marcus Salvage');
    const priyaClient = await clientOwnedBy(priya.id, 'Priya Surplus');

    const links = {
      so: { type: 'so', id: so.id },
      ownPo: { type: 'po', id: marcusPo },
      otherPo: { type: 'po', id: priyaPo },
      ownClient: { type: 'client', id: marcusClient },
      otherClient: { type: 'client', id: priyaClient },
    };
    const ids: Record<string, string> = {};
    for (const [k, link] of Object.entries(links)) {
      const r = await create(alex, { title: k, link });
      expect(r.status).toBe(201);
      ids[k] = r.body.item.id;
    }

    const asManager = new Map((await board(alex)).map(i => [i.id, i.link!]));
    expect(asManager.get(ids.so)).toMatchObject({ type: 'so', label: so.id, canOpen: true });
    expect(asManager.get(ids.so)!.status).toBeTruthy();
    expect(asManager.get(ids.otherClient)).toMatchObject({ label: 'Client', name: 'Priya Surplus', canOpen: true });

    const check = async (w: Who) => {
      const seen = new Map((await board(w)).map(i => [i.id, i.link!]));
      for (const k of ['so', 'otherPo', 'otherClient']) {
        const l = seen.get(ids[k])!;
        expect(l.canOpen, k).toBe(false);
        expect('status' in l, k).toBe(false);
        expect('name' in l, k).toBe(false);
      }
      expect(seen.get(ids.so)!.label).toBe(so.id);
      expect(seen.get(ids.otherClient)!.label).toBe('Client');
      return seen;
    };
    const asMarcus = await check(marcus);
    expect(asMarcus.get(ids.ownPo)).toMatchObject({ canOpen: true, label: marcusPo });
    expect(asMarcus.get(ids.ownPo)!.status).toBeTruthy();
    expect(asMarcus.get(ids.ownClient)).toMatchObject({ canOpen: true, name: 'Marcus Salvage' });

    // A manager previewing as a purchaser gets the purchaser shape.
    await api('PATCH', '/api/me/preferences', { token: alex.token, body: { 'tweaks.rolePreview': 'as_purchaser' } });
    const asPreview = new Map((await board(alex)).map(i => [i.id, i.link!]));
    expect(asPreview.get(ids.so)!.canOpen).toBe(false);
    expect('status' in asPreview.get(ids.so)!).toBe(false);
  });

  it('lets a purchaser link and search only records they can open', async () => {
    const marcus = await who(MARCUS);
    const priya = await who(PRIYA);
    const db = getTestDb();
    const [so] = await db<{ id: string }[]>`SELECT id FROM sell_orders ORDER BY id LIMIT 1`;
    const marcusPo = await poOwnedBy(marcus.id);
    const priyaPo = await poOwnedBy(priya.id);
    const priyaClient = await clientOwnedBy(priya.id, 'Priya Surplus');

    expect((await create(marcus, { title: 'x', link: { type: 'so', id: so.id } })).status).toBe(404);
    expect((await create(marcus, { title: 'x', link: { type: 'po', id: priyaPo } })).status).toBe(404);
    expect((await create(marcus, { title: 'x', link: { type: 'client', id: priyaClient } })).status).toBe(404);
    expect((await create(marcus, { title: 'x', link: { type: 'po', id: marcusPo } })).status).toBe(201);

    expect((await api('GET', '/api/actions/link-targets?type=so', { token: marcus.token })).status).toBe(403);
    const pos = await api<{ items: ActionLinkTarget[] }>('GET', '/api/actions/link-targets?type=po', { token: marcus.token });
    expect(pos.status).toBe(200);
    const mine = new Set((await db<{ id: string }[]>`SELECT id FROM orders WHERE user_id = ${marcus.id}`).map(r => r.id));
    expect(pos.body.items.length).toBeGreaterThan(0);
    expect(pos.body.items.every(t => mine.has(t.id))).toBe(true);
    const clients = await api<{ items: ActionLinkTarget[] }>('GET', '/api/actions/link-targets?type=client&q=Priya', { token: marcus.token });
    expect(clients.body.items).toEqual([]);

    const alex = await who(ALEX);
    const sos = await api<{ items: ActionLinkTarget[] }>('GET', `/api/actions/link-targets?type=so&q=${so.id}`, { token: alex.token });
    expect(sos.body.items[0]).toMatchObject({ type: 'so', id: so.id, label: so.id });
  });

  it('keeps a readable label after the linked record is deleted', async () => {
    const alex = await who(ALEX);
    const db = getTestDb();
    const [lot] = await db<{ id: string; order_id: string; product_no: number }[]>`
      SELECT id, order_id, product_no FROM order_lines
      WHERE NOT EXISTS (SELECT 1 FROM sell_order_lines s WHERE s.inventory_id = order_lines.id)
      ORDER BY order_id, product_no LIMIT 1
    `;
    const id = (await create(alex, { title: 'price this lot', link: { type: 'lot', id: lot.id } })).body.item.id;
    await db`DELETE FROM order_lines WHERE id = ${lot.id}`;
    const item = (await board(alex)).find(i => i.id === id)!;
    expect(item.link).toEqual({
      type: 'lot', id: null, label: `${lot.order_id} #${lot.product_no}`, canOpen: false, deleted: true,
    });

    // Unlinking clears the label too.
    const p = await api<{ item: ActionItem }>('PATCH', `/api/actions/${id}`, { token: alex.token, body: { link: null } });
    expect(p.body.item.link).toBeNull();
  });

  it('lists a record’s cards and counts open cards per record', async () => {
    const alex = await who(ALEX);
    const marcus = await who(MARCUS);
    const po = await poOwnedBy(marcus.id);
    const a = (await create(alex, { title: 'a', link: { type: 'po', id: po } })).body.item.id;
    const b = (await create(alex, { title: 'b', link: { type: 'po', id: po } })).body.item.id;
    await create(alex, { title: 'unlinked' });
    await move(alex, a, 'done');

    const rec = await api<{ items: ActionItem[] }>('GET', `/api/actions/by-record?type=po&id=${po}`, { token: marcus.token });
    expect(rec.body.items.map(i => i.id)).toEqual([b, a]);
    const counts = await api<{ counts: Record<string, number> }>('GET', '/api/actions/counts?type=po', { token: marcus.token });
    expect(counts.body.counts).toEqual({ [po]: 1 });
    expect((await api('GET', '/api/actions/by-record?type=client&id=nope', { token: marcus.token })).status).toBe(400);
  });

  it('lets only the creator or a manager remove a card, and hides it', async () => {
    const alex = await who(ALEX);
    const marcus = await who(MARCUS);
    const priya = await who(PRIYA);
    const byAlex = (await create(alex, { title: 'alex card' })).body.item;
    const byMarcus = (await create(marcus, { title: 'marcus card' })).body.item;
    expect((await board(marcus)).find(i => i.id === byAlex.id)!.canRemove).toBe(false);

    expect((await api('DELETE', `/api/actions/${byAlex.id}`, { token: marcus.token })).status).toBe(403);
    expect((await api('DELETE', `/api/actions/${byMarcus.id}`, { token: priya.token })).status).toBe(403);
    expect((await api('DELETE', `/api/actions/${byMarcus.id}`, { token: marcus.token })).status).toBe(200);
    expect((await api('DELETE', `/api/actions/${byAlex.id}`, { token: alex.token })).status).toBe(200);

    expect(await board(alex)).toEqual([]);
    expect((await api('GET', `/api/actions/${byAlex.id}`, { token: alex.token })).status).toBe(404);
    expect((await api('POST', `/api/actions/${byAlex.id}/notes`, { token: alex.token, body: { note: 'x' } })).status).toBe(404);
    expect((await move(alex, byAlex.id, 'done')).status).toBe(404);
  });

  it('filters the board by assignee and text', async () => {
    const alex = await who(ALEX);
    const marcus = await who(MARCUS);
    await create(alex, { title: 'for marcus', assigneeId: marcus.id });
    await create(alex, { title: 'nobody' });
    expect((await board(marcus, '?assignee=me')).map(i => i.title)).toEqual(['for marcus']);
    expect((await board(alex, '?assignee=none')).map(i => i.title)).toEqual(['nobody']);
    expect((await board(alex, `?assignee=${marcus.id}`)).map(i => i.title)).toEqual(['for marcus']);
    expect((await board(alex, '?q=NOBO')).map(i => i.title)).toEqual(['nobody']);
    expect((await api('GET', '/api/actions?assignee=bob', { token: alex.token })).status).toBe(400);
  });
});
