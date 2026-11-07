import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FbMessage, FbThreadDetail, FbThreadRow } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { hoursAround, managerCount, notificationCount, patchSettings, seedSlot, seedThread } from './helpers/fbSeller';
import { configureFbSellerAlerts, drainFbSellerTelegram, setTelegramSenderForTests } from '../src/lib/fbSellerAlert';
import { runFbSellerTick } from '../src/services/fbPacing';
import { flagHuman, queueOutbound } from '../src/services/fbThreads';


beforeEach(async () => { await resetDb(); });
afterEach(() => { setTelegramSenderForTests(null); configureFbSellerAlerts({ token: undefined, sql: getTestDb() }); });

type Refusal = { error: string; detail: string };
const agent = { author: 'agent' as const, agentRunId: 1 };

async function agentRunId(threadId: number): Promise<number> {
  const [r] = await getTestDb()<{ id: number }[]>`INSERT INTO fb_agent_runs (thread_id, state) VALUES (${threadId}, 'done') RETURNING id::int AS id`;
  return r!.id;
}

describe('who may send', () => {
  it('a take-over stops agent sends but not staff replies', async () => {
    const m = await loginAs(ALEX);
    const acc = await seedSlot({ agentOn: true });
    const t = await seedThread(acc);
    const run = await agentRunId(t);
    const db = getTestDb();
    await db.begin((tx) => queueOutbound(tx, t, 'Queued before the take-over', { ...agent, agentRunId: run }));

    const over = await api<FbThreadDetail>('POST', `/api/fb-seller/threads/${t}/take-over`, { cookies: m.cookies });
    expect(over.body.mode).toBe('human');
    expect(over.body.messages[0]!.send_state).toBe('held');
    expect(over.body.events.map((e) => [e.kind, e.actor_name])).toEqual([['taken_over', expect.not.stringMatching(/^system$/)]]);
    await expect(db.begin((tx) => queueOutbound(tx, t, 'After', { ...agent, agentRunId: run }))).rejects.toThrow(/taken this conversation over/);

    const reply = await api<FbMessage>('POST', `/api/fb-seller/threads/${t}/reply`, { cookies: m.cookies, body: { body: 'A person here. What do you have?' } });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ author: 'staff', send_state: 'queued', direction: 'out', staff_name: expect.any(String) });

    const back = await api<FbThreadDetail>('POST', `/api/fb-seller/threads/${t}/hand-back`, { cookies: m.cookies });
    expect(back.body).toMatchObject({ mode: 'agent', needs_human: false });
    await db.begin((tx) => queueOutbound(tx, t, 'The agent again', { ...agent, agentRunId: run }));
  });

  it('the kill switch holds agent messages but staff ones still go', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); });
    const acc = await seedSlot({ agentOn: true });
    const t = await seedThread(acc);
    const run = await agentRunId(t);
    const db = getTestDb();
    const { messageId: agentMsg } = await db.begin((tx) => queueOutbound(tx, t, 'From the agent', { ...agent, agentRunId: run }));
    await patchSettings((s) => { s.kill_switch = true; });
    await expect(db.begin((tx) => queueOutbound(tx, t, 'More', { ...agent, agentRunId: run }))).rejects.toThrow(/kill switch/);
    const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const { messageId: staffMsg } = await db.begin((tx) => queueOutbound(tx, t, 'From a manager', { author: 'staff', userId: u!.id }));

    const r = await runFbSellerTick(getTestDb(), { now });
    expect(r).toMatchObject({ held: 1, sends: 1 });
    const rows = await db<{ id: number; send_state: string }[]>`SELECT id::int AS id, send_state FROM fb_messages ORDER BY id`;
    expect(rows).toEqual([{ id: agentMsg, send_state: 'held' }, { id: staffMsg, send_state: 'sending' }]);
    const [task] = await db<{ payload: { body: string; fb_thread_id: string; tail: unknown[] } }[]>`SELECT payload FROM fleet_tasks WHERE kind = 'msg-send'`;
    expect(task!.payload).toMatchObject({ body: 'From a manager', tail: [] });
  });

  it('a mirror refuses a reply', async () => {
    const m = await loginAs(ALEX);
    const t = await seedThread(await seedSlot());
    const r = await api<Refusal>('POST', `/api/fb-seller/threads/${t}/reply`, { cookies: m.cookies, body: { body: 'x' }, env: { FLEET_ROLE: 'mirror' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('mirror');
  });
});

describe('thread views', () => {
  it('lists Needs human, the inbox and closed, and closes with an outcome', async () => {
    const m = await loginAs(ALEX);
    const acc = await seedSlot();
    const a = await seedThread(acc);
    const b = await seedThread(acc);
    await getTestDb().begin((tx) => flagHuman(tx, a, 'The seller is ready to close at their price'));
    const list = async (view: string) =>
      (await api<{ rows: FbThreadRow[] }>('GET', `/api/fb-seller/threads?view=${view}`, { cookies: m.cookies })).body.rows.map((r) => r.id);
    expect(await list('needs_human')).toEqual([a]);
    expect((await list('inbox')).sort()).toEqual([a, b].sort());
    const one = await api<{ rows: FbThreadRow[] }>('GET', '/api/fb-seller/threads?view=needs_human', { cookies: m.cookies });
    expect(one.body.rows[0]).toMatchObject({ human_reason: 'The seller is ready to close at their price', ceiling_usd: null });
    expect(await notificationCount('fb_seller_needs_human')).toBe(await managerCount());

    const closed = await api<FbThreadDetail>('POST', `/api/fb-seller/threads/${a}/close`, { cookies: m.cookies, body: { outcome: 'won', note: 'Bought 32 sticks' } });
    expect(closed.body).toMatchObject({ stage: 'won', needs_human: false, close_note: 'Bought 32 sticks' });
    expect(await list('closed')).toEqual([a]);
    expect(await list('needs_human')).toEqual([]);
    const summary = await api<{ needs_human: number }>('GET', '/api/fb-seller/summary', { cookies: m.cookies });
    expect(summary.body.needs_human).toBe(0);

    const q = await api<{ rows: FbThreadRow[] }>('GET', '/api/fb-seller/threads?view=inbox&q=nobody', { cookies: m.cookies });
    expect(q.body.rows).toEqual([]);
    const page = await api<{ rows: FbThreadRow[]; next: string }>('GET', '/api/fb-seller/threads?view=inbox&limit=1', { cookies: m.cookies });
    expect(page.body.rows.map((r) => r.id)).toEqual([b]);
    const page2 = await api<{ rows: FbThreadRow[]; next: string | null }>('GET', `/api/fb-seller/threads?view=inbox&limit=1&cursor=${page.body.next}`, { cookies: m.cookies });
    expect(page2.body).toEqual({ rows: [], next: null });
  });

  it('save-case says so in words until the eval workstream lands', async () => {
    const m = await loginAs(ALEX);
    const t = await seedThread(await seedSlot());
    const r = await api<Refusal | { case_id: number }>('POST', `/api/fb-seller/threads/${t}/save-case`, {
      cookies: m.cookies, body: { name: 'Bot question', expected: { handoff: true } },
    });
    if (r.status === 501) expect((r.body as Refusal).detail).toMatch(/not switched on yet/);
    else expect(r.status).toBe(200);
  });
});

describe('alerts', () => {
  it('reach Telegram after commit, never for a rolled-back transaction', async () => {
    const sent: string[] = [];
    setTelegramSenderForTests(async (_token, chat, text) => { sent.push(`${chat}|${text}`); });
    configureFbSellerAlerts({ token: 'test-token', sql: getTestDb() });
    await patchSettings((s) => { s.alerts.telegram_chat_id = '-100777'; });
    const t = await seedThread(await seedSlot());
    await getTestDb().begin(async (tx) => {
      await flagHuman(tx, t, 'Rolled back');
      throw new Error('roll back');
    }).catch(() => {});
    await getTestDb().begin((tx) => flagHuman(tx, t, 'The seller asked to meet in person'));
    await drainFbSellerTelegram();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^-100777\|Pat Example needs a person \(account \d+\)\nThe seller asked to meet in person/);
    expect(sent[0]).not.toMatch(/\b(409|500|422)\b/);
  });
});
