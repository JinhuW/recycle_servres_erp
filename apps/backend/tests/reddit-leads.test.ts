import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';

type Lead = {
  username: string; name: string; sales: number; claimed: boolean; mine: boolean; holderId: string | null;
  holderName: string | null; stage: string; closed: string; followUp: string | null; dmAt: number | null;
  lastReply: { text: string; by: string } | null; itemsSold: string[];
};
type History = { at: number; actor: string; kind: string; detail: string };

const BASE = '/api/leads/reddit';
const harvest = {
  sellers: [
    { name: 'NewUser156', sales: 289, buys: 4, subreddits: ['homelabsales'], lastDeal: '2026-10-30', itemsSold: ['HP ProDesk 600 G3'] },
    { name: 'DerangedRavens', sales: 143, buys: 0, subreddits: ['homelabsales'], lastDeal: '2026-10-31' },
    { name: 'u/marg330', sales: 81, buys: 6 },
  ],
  buyers: [{ name: 'Frank202312', buys: 59, sales: 0 }],
  trades: [
    { buyer: 'Frank202312', seller: 'NewUser156', item: '2x ProDesk', date: '2026-10-01', url: 'https://www.reddit.com/r/homelabsales/comments/a/b/c/', subreddit: 'homelabsales' },
    { buyer: 'Frank202312', seller: 'NewUser156', item: 'EliteDesk', date: '2026-09-01', subreddit: 'homelabsales' },
    { buyer: 'Frank202312', seller: 'someone_else', item: 'NVMe', date: '2026-08-01', subreddit: 'hardwareswap' },
  ],
};

async function seed() {
  const { token } = await loginAs(ALEX);
  const r = await api<{ sellers: number; added: number; trades: number }>('POST', `${BASE}/import`, { token, body: harvest });
  expect(r.status).toBe(201);
  return r.body;
}
const list = async (token: string) => (await api<{ leads: Lead[] }>('GET', BASE, { token })).body.leads;
const find = (ls: Lead[], u: string) => ls.find((l) => l.username === u)!;

describe('reddit leads', () => {
  beforeEach(resetDb);

  it('imports sellers, buyers and trades; purchasers cannot import', async () => {
    expect(await seed()).toMatchObject({ sellers: 3, added: 3, trades: 3 });
    const { token } = await loginAs(MARCUS);
    expect((await api('POST', `${BASE}/import`, { token, body: harvest })).status).toBe(403);
    const ls = await list(token);
    expect(ls.map((l) => l.username)).toEqual(['newuser156', 'derangedravens', 'marg330']);
    expect(find(ls, 'marg330').name).toBe('marg330');
  });

  it('rejects a bad seller row without writing anything', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ errors: unknown[] }>('POST', `${BASE}/import`, { token, body: { sellers: [{ name: 'ok_name', sales: 1, buys: 0 }, { name: 'bad name!', sales: 1, buys: 0 }] } });
    expect(r.status).toBe(400);
    expect(r.body.errors).toHaveLength(1);
    expect(await list(token)).toHaveLength(0);
  });

  it('a claim is exclusive and other purchasers see only that it is claimed', async () => {
    await seed();
    const marcus = await loginAs(MARCUS), priya = await loginAs(PRIYA), alex = await loginAs(ALEX);
    const c1 = await api<Lead>('POST', `${BASE}/NewUser156/claim`, { token: marcus.token });
    expect(c1.status).toBe(200);
    expect(c1.body).toMatchObject({ claimed: true, mine: true, holderName: marcus.user.name, stage: 'claimed' });

    const c2 = await api<{ code: string }>('POST', `${BASE}/newuser156/claim`, { token: priya.token });
    expect(c2.status).toBe(409);
    expect(c2.body.code).toBe('rlTakenElsewhere');

    await api('POST', `${BASE}/newuser156/reply`, { token: marcus.token, body: { text: 'Has 40 Optiplex' } });
    const seen = find(await list(priya.token), 'newuser156');
    expect(seen).toMatchObject({ claimed: true, mine: false, holderId: null, holderName: null, followUp: null, lastReply: null, stage: 'claimed' });
    const detail = await api<{ history: History[] }>('GET', `${BASE}/newuser156`, { token: priya.token });
    expect(detail.body.history).toEqual([]);

    const mgr = find(await list(alex.token), 'newuser156');
    expect(mgr).toMatchObject({ holderName: marcus.user.name, stage: 'replied', lastReply: { text: 'Has 40 Optiplex' } });
  });

  it('works a lead through DM, reply, stage, follow-up, close and reopen', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    await api('POST', `${BASE}/derangedravens/claim`, { token });

    const dm = await api<Lead>('POST', `${BASE}/derangedravens/dm`, { token, body: { template: 'Bulk inventory' } });
    expect(dm.body.stage).toBe('dm');
    expect(dm.body.followUp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dm.body.dmAt).not.toBeNull();

    expect((await api('POST', `${BASE}/derangedravens/reply`, { token, body: { text: '  ' } })).status).toBe(400);
    const rep = await api<Lead>('POST', `${BASE}/derangedravens/reply`, { token, body: { text: 'Out of 18TB until Dec' } });
    expect(rep.body).toMatchObject({ stage: 'replied', followUp: null, lastReply: { text: 'Out of 18TB until Dec' } });

    expect((await api('PUT', `${BASE}/derangedravens/stage`, { token, body: { stage: 'bogus' } })).status).toBe(400);
    expect((await api<Lead>('PUT', `${BASE}/derangedravens/stage`, { token, body: { stage: 'talks' } })).body.stage).toBe('talks');
    expect((await api<Lead>('PUT', `${BASE}/derangedravens/follow-up`, { token, body: { date: '2026-12-01' } })).body.followUp).toBe('2026-12-01');
    expect((await api('PUT', `${BASE}/derangedravens/follow-up`, { token, body: { date: 'soon' } })).status).toBe(400);

    const closed = await api<Lead>('PUT', `${BASE}/derangedravens/close`, { token, body: { closed: 'nostock' } });
    expect(closed.body.closed).toBe('nostock');
    expect(closed.body.followUp).not.toBeNull();
    const reopened = await api<Lead>('POST', `${BASE}/derangedravens/reopen`, { token });
    expect(reopened.body).toMatchObject({ closed: '', stage: 'talks' });

    // A follow-up in the past is waiting on the holder.
    await api('PUT', `${BASE}/derangedravens/follow-up`, { token, body: { date: '2020-01-01' } });
    expect((await api<{ n: number }>('GET', `${BASE}/attention`, { token })).body.n).toBe(1);

    const won = await api<Lead>('PUT', `${BASE}/derangedravens/stage`, { token, body: { stage: 'won' } });
    expect(won.body).toMatchObject({ stage: 'won', followUp: null });

    const { body } = await api<{ history: History[] }>('GET', `${BASE}/derangedravens`, { token });
    expect(body.history.map((h) => h.kind)).toEqual(['stage', 'follow_up', 'reopened', 'closed', 'follow_up', 'stage', 'reply', 'dm', 'claimed']);
    expect((await api<{ n: number }>('GET', `${BASE}/attention`, { token })).body.n).toBe(0);
  });

  it('only the holder or a manager works or releases a lead', async () => {
    await seed();
    const marcus = await loginAs(MARCUS), priya = await loginAs(PRIYA), alex = await loginAs(ALEX);
    expect((await api<{ code: string }>('POST', `${BASE}/marg330/dm`, { token: marcus.token })).body.code).toBe('rlNotClaimed');
    await api('POST', `${BASE}/marg330/claim`, { token: marcus.token });
    expect((await api('POST', `${BASE}/marg330/reply`, { token: priya.token, body: { text: 'x' } })).status).toBe(403);
    expect((await api('POST', `${BASE}/marg330/release`, { token: priya.token })).status).toBe(403);
    const rel = await api<Lead>('POST', `${BASE}/marg330/release`, { token: alex.token });
    expect(rel.body).toMatchObject({ claimed: false, holderName: null, stage: 'claimed' });
    expect((await api('POST', `${BASE}/marg330/claim`, { token: priya.token })).status).toBe(200);
    expect((await api('GET', `${BASE}/nobody_here`, { token: priya.token })).status).toBe(404);
  });

  it('a re-import updates counts and keeps the claim and its stage', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    await api('POST', `${BASE}/newuser156/claim`, { token });
    await api('POST', `${BASE}/newuser156/dm`, { token, body: {} });
    const alex = await loginAs(ALEX);
    const again = await api<{ added: number; updated: number }>('POST', `${BASE}/import`, {
      token: alex.token, body: { sellers: [{ name: 'NewUser156', sales: 300, buys: 5, itemsSold: ['Optiplex 3090'] }, { name: 'fresh_seller', sales: 2, buys: 0 }] },
    });
    expect(again.body).toMatchObject({ added: 1, updated: 1 });
    const l = find(await list(token), 'newuser156');
    expect(l).toMatchObject({ sales: 300, mine: true, stage: 'dm', itemsSold: ['Optiplex 3090'] });
    // No buyers in the body: the buyer network is left alone.
    expect((await api<{ buyers: unknown[] }>('GET', `${BASE}/buyers`, { token })).body.buyers).toHaveLength(1);
  });

  it('serves the buyer network grouped by seller', async () => {
    await seed();
    const { token } = await loginAs(PRIYA);
    const buyers = await api<{ buyers: { username: string; sellers: number }[] }>('GET', `${BASE}/buyers`, { token });
    expect(buyers.body.buyers).toEqual([expect.objectContaining({ username: 'frank202312', sellers: 2, buys: 59 })]);
    const tree = await api<{ sellers: { username: string; name: string; trades: { date: string; url: string }[] }[] }>('GET', `${BASE}/buyers/Frank202312`, { token });
    expect(tree.body.sellers.map((s) => [s.username, s.trades.length])).toEqual([['newuser156', 2], ['someone_else', 1]]);
    expect(tree.body.sellers[0].name).toBe('NewUser156');
    expect(tree.body.sellers[0].trades[0]).toMatchObject({ date: '2026-10-01', url: expect.stringContaining('reddit.com') });
    expect(tree.body.sellers[0].trades[1].url).toBe('');
  });

  it('keeps the event ledger append-only', async () => {
    await seed();
    const sql = getTestDb();
    await expect(sql`UPDATE reddit_lead_events SET detail = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM reddit_lead_events`).rejects.toThrow(/append-only/);
  });
});
