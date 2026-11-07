import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InboxThread, SellerReport } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { ALEX } from './helpers/auth';
import { patchSettings, seedSlot } from './helpers/fbSeller';
import { alignWindow, applySellerReport } from '../src/services/fbSellerReports';
import { queueOutbound } from '../src/services/fbThreads';

const agentRuns = vi.hoisted(() => [] as { threadId: number; messageId: number }[]);
vi.mock('../src/services/fbAgent', () => ({
  enqueueAgentRun: async (_tx: unknown, threadId: number, messageId: number) => { agentRuns.push({ threadId, messageId }); },
  decide: async () => { throw new Error('not used'); },
  startFbAgentLoop: () => ({ stop: () => {} }),
}));

beforeEach(async () => { await resetDb(); agentRuns.length = 0; });

const inn = (body: string, has_image = false) => ({ direction: 'in' as const, body, has_image });
const out = (body: string) => ({ direction: 'out' as const, body, has_image: false });

async function inboxTask(accountNo: number): Promise<number> {
  const ref = `inbox:${Math.random()}`;
  const [t] = await getTestDb()<{ id: number }[]>`
    INSERT INTO fleet_tasks (kind, due_at, state, account_no, payload)
    VALUES ('inbox-sync', NOW(), 'leased', ${accountNo}, ${getTestDb().json({ ref, kind: 'inbox-sync', max_threads: 10, max_messages: 25 })})
    RETURNING id::int AS id`;
  return t!.id;
}

async function report(accountNo: number, threads: InboxThread[]): Promise<{ accepted: boolean; detail?: string }> {
  const taskId = await inboxTask(accountNo);
  const [t] = await getTestDb()<{ ref: string }[]>`SELECT payload->>'ref' AS ref FROM fleet_tasks WHERE id = ${taskId}`;
  const r: SellerReport = { task_id: taskId, kind: 'inbox-sync', ref: t!.ref, outcome: 'ok', data: { threads } };
  return getTestDb().begin((tx) => applySellerReport(tx, accountNo, r));
}

const thread = (messages: InboxThread['messages']): InboxThread =>
  ({ fb_thread_id: 'fbt-1', seller_name: 'Sam Sample', listing_title: 'We buy server RAM', messages });

async function stored(): Promise<{ seq: number | null; direction: string; author: string; body: string; send_state: string | null }[]> {
  return getTestDb()`SELECT seq, direction, author, body, send_state FROM fb_messages ORDER BY seq NULLS LAST, id`;
}
async function events(): Promise<string[]> {
  return (await getTestDb()<{ kind: string }[]>`SELECT kind FROM fb_thread_events ORDER BY id`).map((e) => e.kind);
}

describe('alignWindow', () => {
  const m = (d: string, b: string) => ({ direction: d, body: b });
  it('finds the longest end-of-conversation run the window starts with', () => {
    expect(alignWindow([m('in', 'a'), m('out', 'b'), m('in', 'c')], [m('out', 'b'), m('in', 'c'), m('in', 'd')])).toBe(2);
    expect(alignWindow([m('in', 'a')], [m('in', 'x')])).toBe(0);
    expect(alignWindow([], [m('in', 'x')])).toBe(0);
  });
  it('keeps repeats: two "ok"s after one stored "ok" leave one new', () => {
    expect(alignWindow([m('in', 'hi'), m('in', 'ok')], [m('in', 'hi'), m('in', 'ok'), m('in', 'ok')])).toBe(2);
    expect(alignWindow([m('in', 'ok'), m('in', 'ok')], [m('in', 'ok'), m('in', 'ok'), m('in', 'ok')])).toBe(2);
  });
});

describe('ingesting an inbox report', () => {
  it('creates the thread, appends new messages only, and keeps repeated ones', async () => {
    const acc = await seedSlot();
    expect(await report(acc, [thread([inn('Hi, I have 32 sticks of DDR4'), inn('ok')])])).toEqual({ accepted: true });
    expect(await report(acc, [thread([inn('ok'), inn('ok'), inn('Are you there?')])])).toEqual({ accepted: true });
    expect((await stored()).map((s) => [s.seq, s.body])).toEqual([
      [1, 'Hi, I have 32 sticks of DDR4'], [2, 'ok'], [3, 'ok'], [4, 'Are you there?'],
    ]);
    expect(await events()).toEqual(['created', 'inbound', 'inbound', 'inbound', 'inbound']);
    const [t] = await getTestDb()<{ unread: boolean; last_seq: number }[]>`SELECT unread, last_seq FROM fb_threads`;
    expect(t).toEqual({ unread: true, last_seq: 4 });
    // The same window again is a no-op.
    await report(acc, [thread([inn('ok'), inn('ok'), inn('Are you there?')])]);
    expect(await stored()).toHaveLength(4);
  });

  it('settles a sent outbound by its text, and stores an outbound nobody queued as facebook', async () => {
    const acc = await seedSlot();
    await report(acc, [thread([inn('Hello')])]);
    const db = getTestDb();
    const [{ id: threadId }] = await db<{ id: number }[]>`SELECT id::int AS id FROM fb_threads`;
    const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const { messageId } = await db.begin((tx) => queueOutbound(tx, threadId, 'What model numbers?', { author: 'staff', userId: u!.id }));
    await db`UPDATE fb_messages SET send_state = 'uncertain' WHERE id = ${messageId}`;
    await report(acc, [thread([inn('Hello'), out('What model numbers?'), out('Typed on the phone'), inn('M393A4K40DB3')])]);
    expect((await stored()).map((s) => [s.seq, s.author, s.send_state])).toEqual([
      [1, 'seller', null], [2, 'staff', 'sent'], [3, 'facebook', null], [4, 'seller', null],
    ]);
    expect(await events()).toContain('staff_sent');
  });

  it('an uncertain reply missing from the window fails and hands the thread off', async () => {
    const acc = await seedSlot();
    await report(acc, [thread([inn('Hello')])]);
    const db = getTestDb();
    const [{ id: threadId }] = await db<{ id: number }[]>`SELECT id::int AS id FROM fb_threads`;
    const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const { messageId } = await db.begin((tx) => queueOutbound(tx, threadId, 'Lost reply', { author: 'staff', userId: u!.id }));
    await db`UPDATE fb_messages SET send_state = 'uncertain' WHERE id = ${messageId}`;
    await report(acc, [thread([inn('Hello'), inn('Still there?')])]);
    const [m] = await db<{ send_state: string; error: string }[]>`SELECT send_state, error FROM fb_messages WHERE id = ${messageId}`;
    expect(m).toEqual({ send_state: 'failed', error: 'A reply may not have reached the seller' });
    const [t] = await db<{ needs_human: boolean; human_reason: string }[]>`SELECT needs_human, human_reason FROM fb_threads`;
    expect(t).toEqual({ needs_human: true, human_reason: 'A reply may not have reached the seller' });
  });

  it('a window that matches nothing stored is appended with a realigned event', async () => {
    const acc = await seedSlot();
    await report(acc, [thread([inn('First'), inn('Second')])]);
    await report(acc, [thread([inn('Much later'), inn('Even later')])]);
    expect((await stored()).map((s) => s.body)).toEqual(['First', 'Second', 'Much later', 'Even later']);
    expect(await events()).toContain('realigned');
  });

  it('asks for an agent run only in agent mode, without a hand-off, with the agent on and the kill switch off', async () => {
    const off = await seedSlot({ agentOn: false });
    const on = await seedSlot({ agentOn: true });
    await report(off, [thread([inn('a')])]);
    expect(agentRuns).toHaveLength(0);
    await report(on, [thread([inn('a'), inn('b', true)])]);
    expect(agentRuns).toHaveLength(1);
    const [last] = await getTestDb()<{ id: number }[]>`SELECT MAX(id)::int AS id FROM fb_messages WHERE body = 'b'`;
    expect(agentRuns[0]!.messageId).toBe(last!.id);

    await getTestDb()`UPDATE fb_threads SET needs_human = TRUE WHERE account_no = ${on}`;
    await report(on, [thread([inn('b', true), inn('c')])]);
    expect(agentRuns).toHaveLength(1);
    await getTestDb()`UPDATE fb_threads SET needs_human = FALSE, mode = 'human' WHERE account_no = ${on}`;
    await report(on, [thread([inn('c'), inn('d')])]);
    expect(agentRuns).toHaveLength(1);
    await getTestDb()`UPDATE fb_threads SET mode = 'agent' WHERE account_no = ${on}`;
    await patchSettings((s) => { s.kill_switch = true; });
    await report(on, [thread([inn('d'), inn('e')])]);
    expect(agentRuns).toHaveLength(1);
    await patchSettings((s) => { s.kill_switch = false; });
    await report(on, [thread([inn('e'), { direction: 'unknown', body: '?', has_image: false }])]);
    expect(agentRuns).toHaveLength(2);
  });

  it('refuses a report for a task the account was not handed', async () => {
    const acc = await seedSlot();
    const other = await seedSlot();
    const taskId = await inboxTask(other);
    const r = await getTestDb().begin((tx) => applySellerReport(tx, acc, { task_id: taskId, kind: 'inbox-sync', ref: 'x', outcome: 'ok', data: { threads: [] } }));
    expect(r.accepted).toBe(false);
  });
});

describe('send and post reports', () => {
  it('a sent message is marked once; a failed one hands off; an ad-post goes live', async () => {
    const acc = await seedSlot();
    const db = getTestDb();
    await report(acc, [thread([inn('Hello')])]);
    const [{ id: threadId }] = await db<{ id: number }[]>`SELECT id::int AS id FROM fb_threads`;
    const [u] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const send = async (body: string) => {
      const { messageId } = await db.begin((tx) => queueOutbound(tx, threadId, body, { author: 'staff', userId: u!.id }));
      const [t] = await db<{ id: number }[]>`
        INSERT INTO fleet_tasks (kind, due_at, state, account_no, payload)
        VALUES ('msg-send', NOW(), 'leased', ${acc}, ${db.json({ ref: String(messageId) })}) RETURNING id::int AS id`;
      await db`UPDATE fb_messages SET send_state = 'sending', task_id = ${t!.id} WHERE id = ${messageId}`;
      return { messageId, taskId: t!.id };
    };
    const a = await send('One');
    const okReport: SellerReport = { task_id: a.taskId, kind: 'msg-send', ref: String(a.messageId), outcome: 'ok', data: { already_sent: false } };
    await db.begin((tx) => applySellerReport(tx, acc, okReport));
    await db.begin((tx) => applySellerReport(tx, acc, okReport));
    const [m] = await db<{ send_state: string }[]>`SELECT send_state FROM fb_messages WHERE id = ${a.messageId}`;
    expect(m!.send_state).toBe('sent');
    expect((await events()).filter((e) => e === 'staff_sent')).toHaveLength(1);

    const b = await send('Two');
    await db.begin((tx) => applySellerReport(tx, acc, { task_id: b.taskId, kind: 'msg-send', ref: String(b.messageId), outcome: 'failed', detail: 'The message box was not there' }));
    const [t] = await db<{ needs_human: boolean; human_reason: string }[]>`SELECT needs_human, human_reason FROM fb_threads`;
    expect(t).toEqual({ needs_human: true, human_reason: 'A reply could not be sent: The message box was not there' });
  });
});
