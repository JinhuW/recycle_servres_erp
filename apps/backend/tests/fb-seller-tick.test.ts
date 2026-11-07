import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { ALEX } from './helpers/auth';
import { hoursAround, patchSettings, seedAd, seedPool, seedSlot, seedThread } from './helpers/fbSeller';
import { runFbSellerTick, withinActiveHours } from '../src/services/fbPacing';
import { flagHuman, holdAgentReplies, queueOutbound } from '../src/services/fbThreads';
import { HONEST_LINE } from '../src/services/fbAgent/guards';
import { placeAd } from '../src/services/fbAds';


beforeEach(async () => { await resetDb(); });

const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

async function tasks(kind: string): Promise<{ id: number; account_no: number; state: string; payload: Record<string, unknown> }[]> {
  return getTestDb()`SELECT id::int AS id, account_no, state, payload FROM fleet_tasks WHERE kind = ${kind} ORDER BY id`;
}
/** The worker finishing a task at `when`. */
async function finish(id: number, when: Date): Promise<void> {
  await getTestDb()`UPDATE fleet_tasks SET state = 'done', leased_at = ${when}, done_at = ${when} WHERE id = ${id}`;
}
async function staffQueue(threadId: number, body: string): Promise<number> {
  const db = getTestDb();
  const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
  return (await db.begin((tx) => queueOutbound(tx, threadId, body, { author: 'staff', userId: u!.id }))).messageId;
}

describe('active hours', () => {
  it('handles a window that wraps past midnight', () => {
    const noonUtc = new Date('2026-11-07T12:00:00Z');
    expect(withinActiveHours(noonUtc, { start: '08:00', end: '22:00', tz: 'UTC' })).toBe(true);
    expect(withinActiveHours(noonUtc, { start: '22:00', end: '08:00', tz: 'UTC' })).toBe(false);
    expect(withinActiveHours(new Date('2026-11-07T23:30:00Z'), { start: '22:00', end: '08:00', tz: 'UTC' })).toBe(true);
    // 12:00 UTC is 05:00 in Denver in November.
    expect(withinActiveHours(noonUtc, { start: '08:00', end: '22:00', tz: 'America/Denver' })).toBe(false);
  });
});

describe('inbox syncs', () => {
  it('go to healthy seller slots only, spaced by the interval', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); s.pacing.inbox_every_minutes = 5; s.pacing.inbox_jitter_minutes = 0; });
    const seller = await seedSlot();
    await seedSlot({ healthy: false });
    await seedSlot({ role: 'search' });
    await runFbSellerTick(getTestDb(), { now });
    let t = await tasks('inbox-sync');
    expect(t.map((x) => x.account_no)).toEqual([seller]);
    expect(t[0]!.payload).toMatchObject({ kind: 'inbox-sync', max_threads: 10, max_messages: 25 });
    await finish(t[0]!.id, now);
    await runFbSellerTick(getTestDb(), { now: at(now, 3) });
    expect(await tasks('inbox-sync')).toHaveLength(1);
    await runFbSellerTick(getTestDb(), { now: at(now, 5) });
    t = await tasks('inbox-sync');
    expect(t).toHaveLength(2);
  });
});

describe('message sends', () => {
  it('one open per account, oldest first, spaced by the gap', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); s.pacing.send_gap_seconds = 60; s.pacing.send_jitter_seconds = 0; });
    const acc = await seedSlot();
    const t1 = await seedThread(acc);
    const t2 = await seedThread(acc);
    const first = await staffQueue(t1, 'first');
    const second = await staffQueue(t2, 'second');
    expect((await runFbSellerTick(getTestDb(), { now })).sends).toBe(1);
    // Still open: nothing more for this account.
    expect((await runFbSellerTick(getTestDb(), { now: at(now, 5) })).sends).toBe(0);
    let sends = await tasks('msg-send');
    expect(sends.map((s) => s.payload.ref)).toEqual([String(first)]);
    await finish(sends[0]!.id, now);
    expect((await runFbSellerTick(getTestDb(), { now: at(now, 0.5) })).sends).toBe(0);
    expect((await runFbSellerTick(getTestDb(), { now: at(now, 1) })).sends).toBe(1);
    sends = await tasks('msg-send');
    expect(sends.map((s) => s.payload.ref)).toEqual([String(first), String(second)]);
  });

  it('stop at the daily cap', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); s.pacing.sends_per_account_day = 1; s.pacing.send_gap_seconds = 10; s.pacing.send_jitter_seconds = 0; });
    const acc = await seedSlot();
    const t = await seedThread(acc);
    await staffQueue(t, 'one');
    await staffQueue(t, 'two');
    await runFbSellerTick(getTestDb(), { now });
    const [s] = await tasks('msg-send');
    await finish(s!.id, now);
    expect((await runFbSellerTick(getTestDb(), { now: at(now, 2) })).sends).toBe(0);
  });

  it('a lost lease leaves the message uncertain', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); });
    const acc = await seedSlot();
    const t = await seedThread(acc);
    const id = await staffQueue(t, 'maybe');
    await runFbSellerTick(getTestDb(), { now });
    await getTestDb()`UPDATE fleet_tasks SET state = 'uncertain', leased_at = NOW() WHERE kind = 'msg-send'`;
    expect((await runFbSellerTick(getTestDb(), { now })).settled).toBe(1);
    const [m] = await getTestDb()<{ send_state: string }[]>`SELECT send_state FROM fb_messages WHERE id = ${id}`;
    expect(m!.send_state).toBe('uncertain');
  });
});

describe('ad actions', () => {
  it('post with the photos, one action per gap, under the live cap; removals first', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); s.pacing.ad_action_gap_minutes = 20; s.pacing.max_live_ads_per_account = 1; s.pacing.same_ad_location_per_day = 5; });
    const acc = await seedSlot();
    const { poolId } = await seedPool('p', 10);
    const ad = await seedAd(poolId, { min: 2, max: 2 });
    const db = getTestDb();
    const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const { placements } = await db.begin((tx) => placeAd(tx, ad, { account_nos: [acc], locations: ['Denver, CO', 'Boulder, CO'] }, u!.id));

    expect((await runFbSellerTick(getTestDb(), { now })).posts).toBe(1);
    const [post] = await tasks('ad-post');
    expect(post!.payload).toMatchObject({ kind: 'ad-post', ref: String(placements[0]!.id), location: 'Denver, CO', title: 'We buy server RAM' });
    expect((post!.payload.photos as unknown[]).length).toBe(2);
    await finish(post!.id, now);
    await db`UPDATE fb_ad_placements SET state = 'live', fb_listing_id = '111222333', posted_at = NOW() WHERE id = ${placements[0]!.id}`;

    // The gap holds the next action; past it, the live cap still holds the second post.
    expect((await runFbSellerTick(getTestDb(), { now: at(now, 10) })).posts).toBe(0);
    expect((await runFbSellerTick(getTestDb(), { now: at(now, 25) })).posts).toBe(0);

    // A removal goes before any post.
    await db`UPDATE fb_ad_placements SET state = 'removing' WHERE id = ${placements[0]!.id}`;
    const r = await runFbSellerTick(getTestDb(), { now: at(now, 25) });
    expect(r).toMatchObject({ deletes: 1, posts: 0 });
    const [del] = await tasks('ad-delete');
    expect(del!.payload).toMatchObject({ kind: 'ad-delete', fb_listing_id: '111222333' });
  });

  it('a due renewal makes a new placement and takes the old one down', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); });
    const acc = await seedSlot();
    const { poolId } = await seedPool('p', 10);
    const ad = await seedAd(poolId);
    const db = getTestDb();
    const [p] = await db<{ id: number }[]>`
      INSERT INTO fb_ad_placements (ad_id, account_no, location, content, state, fb_listing_id, posted_at, next_renew_at)
      VALUES (${ad}, ${acc}, 'Denver, CO', '{"title":"We buy server RAM"}', 'live', '999888777', NOW() - interval '8 days', NOW() - interval '1 hour')
      RETURNING id::int AS id`;
    const r = await runFbSellerTick(getTestDb(), { now });
    expect(r).toMatchObject({ renewed: 1, deletes: 1 });
    const rows = await db<{ id: number; state: string; renews_id: number | null }[]>`
      SELECT id::int AS id, state, renews_id::int AS renews_id FROM fb_ad_placements ORDER BY id`;
    expect(rows).toEqual([{ id: p!.id, state: 'removing', renews_id: null }, { id: expect.any(Number), state: 'queued', renews_id: p!.id }]);
  });
});

describe('the agent stops (RS-565 review)', () => {
  async function agentQueue(threadId: number, body: string): Promise<number> {
    const db = getTestDb();
    const [run] = await db<{ id: number }[]>`INSERT INTO fb_agent_runs (thread_id) VALUES (${threadId}) RETURNING id::int AS id`;
    return (await db.begin((tx) => queueOutbound(tx, threadId, body, { author: 'agent', agentRunId: run!.id }))).messageId;
  }
  const state = async (id: number) =>
    (await getTestDb()<{ send_state: string }[]>`SELECT send_state FROM fb_messages WHERE id = ${id}`)[0]!.send_state;

  it('a hand-off still sends the honest line it queued first', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); });
    const account = await seedSlot({ agentOn: true });
    const threadId = await seedThread(account);
    const honest = await agentQueue(threadId, HONEST_LINE);
    const other = await agentQueue(threadId, 'What part numbers do you have?');
    await getTestDb().begin((tx) => flagHuman(tx, threadId, 'The seller asked whether they are talking to a person.'));
    expect(await state(honest)).toBe('queued');
    expect(await state(other)).toBe('held');
    await runFbSellerTick(getTestDb(), { now });
    expect(await state(honest)).toBe('sending');
    expect((await tasks('msg-send'))[0]!.payload).toMatchObject({ body: HONEST_LINE });
  });

  it('a take-over or the kill switch stops a reply whose send task no worker has taken', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); });
    const account = await seedSlot({ agentOn: true });
    const a = await seedThread(account);
    const b = await seedThread(account);
    const m1 = await agentQueue(a, 'What part numbers do you have?');
    await runFbSellerTick(getTestDb(), { now });
    expect(await state(m1)).toBe('sending');
    const [t1] = await tasks('msg-send');
    await getTestDb().begin((tx) => holdAgentReplies(tx, a, { keepHonest: false }));
    expect(await state(m1)).toBe('held');
    expect((await tasks('msg-send')).find((t) => t.id === t1!.id)!.state).toBe('cancelled');

    // The kill switch, through the tick, does the same; a leased one runs out.
    const m2 = await agentQueue(b, 'How many sticks?');
    await runFbSellerTick(getTestDb(), { now: at(now, 10) });
    expect(await state(m2)).toBe('sending');
    await patchSettings((s) => { s.kill_switch = true; });
    await runFbSellerTick(getTestDb(), { now: at(now, 11) });
    expect(await state(m2)).toBe('held');
    expect((await tasks('msg-send')).every((t) => t.state === 'cancelled')).toBe(true);
    // Nothing queues the held replies again.
    await patchSettings((s) => { s.kill_switch = false; });
    await runFbSellerTick(getTestDb(), { now: at(now, 20) });
    expect(await tasks('msg-send')).toHaveLength(2);
  });
});
