// The agent loop against a real database: queueing, claiming, the decision
// applied through the thread functions, shadow runs, the daily budget and
// the circuit breaker. C's fbThreads is replaced by an in-test fake that
// records every call, so this runs whether or not C has merged.

import { describe, it, expect, beforeEach } from 'vitest';
import type { FbThreadSnapshot } from '@recycle-erp/shared';
import type { Sql } from 'postgres';
import {
  claimFbAgentRun, drainFbAgentRuns, enqueueAgentRun, startFbAgentLoop,
  type AgentDeps, type AgentThreads,
} from '../src/services/fbAgent';
import { HONEST_LINE } from '../src/services/fbAgent/guards';
import { getTestDb, resetDb } from './helpers/db';
import { testEnv } from './helpers/app';
import { PN, extractOf, scriptedLlm, type Script } from './helpers/fbAgent';

type Call = { fn: string; threadId: number; args: unknown[] };

function fakeThreads(db: Sql, calls: Call[], opts: { refuseSend?: boolean } = {}): AgentThreads {
  const rec = (fn: string) => async (_tx: unknown, threadId: number, ...args: unknown[]) => {
    calls.push({ fn, threadId, args });
  };
  return {
    async loadThreadSnapshot(_tx, threadId): Promise<FbThreadSnapshot> {
      const [t] = await db<FbThreadSnapshot['thread'][]>`
        SELECT id::int AS id, account_no, stage, mode, needs_human, round, offer_usd::float AS offer_usd,
               ceiling_usd::float AS ceiling_usd, listing_title, extracted
        FROM fb_threads WHERE id = ${threadId}`;
      const messages = await db<FbThreadSnapshot['messages']>`
        SELECT id::int AS id, seq, direction, author, body, has_image FROM fb_messages
        WHERE thread_id = ${threadId} ORDER BY seq NULLS LAST, id`;
      return { thread: t!, messages };
    },
    recordExtract: rec('recordExtract') as AgentThreads['recordExtract'],
    recordOffer: rec('recordOffer') as AgentThreads['recordOffer'],
    setStage: rec('setStage') as AgentThreads['setStage'],
    flagHuman: rec('flagHuman') as AgentThreads['flagHuman'],
    async queueOutbound(_tx, threadId, body, by) {
      if (opts.refuseSend) throw new Error('A person has taken this thread over.');
      calls.push({ fn: 'queueOutbound', threadId, args: [body, by] });
      return { messageId: 1 };
    },
  };
}

type Alert = { kind: string; title: string; reason: string };

function deps(db: Sql, calls: Call[], alerts: Alert[], script: Script = {}, opts: { refuseSend?: boolean } = {}): AgentDeps {
  return {
    threads: fakeThreads(db, calls, opts),
    alert: async (_tx, a) => { alerts.push(a); },
    llm: scriptedLlm(script),
    now: () => new Date('2026-11-07T18:00:00Z'),
  };
}

let accountNo = 0;
let uid = 61550000000100;

async function seedAccount(db: Sql, agentOn = true): Promise<number> {
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name)
    VALUES (${String(uid++)}, 'fixtures', 'fleet', 'seller-fixture') RETURNING no`;
  await db`INSERT INTO fleet_slots (account_no, role, agent_on) VALUES (${a!.no}, 'seller', ${agentOn})`;
  return a!.no;
}

async function seedThread(db: Sql, account: number, sellerText = `I have 8 sticks of ${PN}`): Promise<{ threadId: number; messageId: number }> {
  const [t] = await db<{ id: number }[]>`
    INSERT INTO fb_threads (account_no, fb_thread_id, seller_name, listing_title, stage)
    VALUES (${account}, ${'t-' + Math.random().toString(36).slice(2)}, 'Test Seller', 'We buy server memory', 'screening')
    RETURNING id::int AS id`;
  await db`INSERT INTO fb_messages (thread_id, seq, direction, author, body) VALUES
    (${t!.id}, 1, 'in', 'seller', 'hi, saw your ad'),
    (${t!.id}, 2, 'out', 'agent', 'Thanks for reaching out! What part numbers and how many?')`;
  const [m] = await db<{ id: number }[]>`
    INSERT INTO fb_messages (thread_id, seq, direction, author, body)
    VALUES (${t!.id}, 3, 'in', 'seller', ${sellerText}) RETURNING id::int AS id`;
  return { threadId: t!.id, messageId: m!.id };
}

async function setSettings(db: Sql, path: string[], value: unknown) {
  await db`UPDATE fb_seller_settings SET value = jsonb_set(value, ${path}, ${db.json(value as never)}) WHERE id = 1`;
}

const runs = (db: Sql) => db<{ id: number; state: string; outcome: string | null; shadow: boolean; error: string | null;
  profile_id: number; input: { market: { part_number: string; max_buy_unit: number }[] } | null;
  decision: { handoff_reason: string | null; offer: { offer_usd: number } | null } | null; cost_usd: number | null }[]>`
  SELECT id::int AS id, state, outcome, shadow, error, profile_id::int AS profile_id, input, decision, cost_usd::float AS cost_usd
  FROM fb_agent_runs ORDER BY id`;

describe('fb agent loop', () => {
  let db: Sql;
  let calls: Call[];
  let alerts: Alert[];
  beforeEach(async () => {
    await resetDb();
    db = getTestDb() as unknown as Sql;
    calls = [];
    alerts = [];
    accountNo = await seedAccount(db);
    await db`
      INSERT INTO ref_prices (id, category, label, part_number, avg_sell, last_price, last_price_at, updated_at)
      VALUES ('fb-agent-loop', 'RAM', 'Samsung 32GB', ${PN}, 50, 50, NOW() - INTERVAL '2 days', NOW())`;
  });

  it('queues one run per thread and points it at the newest message', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId - 1);
    await enqueueAgentRun(db, threadId, messageId);
    const rows = await db`SELECT trigger_message_id::int AS m FROM fb_agent_runs WHERE thread_id = ${threadId}`;
    expect(rows).toEqual([{ m: messageId }]);
  });

  it('runs a queued run: stores input and decision, applies a send in order', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId);
    expect(await drainFbAgentRuns(db, deps(db, calls, alerts))).toBe(1);
    const [r] = await runs(db);
    expect(r).toMatchObject({ state: 'done', outcome: 'send', shadow: false });
    // The Market row was found from what the seller typed, priced at the seeded margin.
    expect(r!.input!.market).toEqual([expect.objectContaining({ part_number: PN, max_buy_unit: 35 })]);
    // 8 × 35 = 280; 70% → 196.
    expect(r!.decision!.offer).toMatchObject({ offer_usd: 196 });
    expect(r!.cost_usd).toBeCloseTo(0.003);
    expect(calls.map((c) => c.fn)).toEqual(['recordExtract', 'recordOffer', 'setStage', 'queueOutbound']);
    expect(calls[3]!.args).toEqual([expect.stringContaining('$196'), { author: 'agent', agentRunId: r!.id }]);
  });

  it('hand-off flags a person; the bot question sends the honest line first', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo, 'is this a bot?');
    await enqueueAgentRun(db, threadId, messageId);
    await drainFbAgentRuns(db, deps(db, calls, alerts, { extract: extractOf({ intent: 'bot_question' }) }));
    expect(calls.map((c) => c.fn)).toEqual(['recordExtract', 'queueOutbound', 'flagHuman']);
    expect(calls[1]!.args[0]).toBe(HONEST_LINE);
    expect((await runs(db))[0]).toMatchObject({ outcome: 'handoff' });
  });

  it('does nothing while the kill switch is on, the agent is off, or a person has the thread', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo);
    await setSettings(db, ['kill_switch'], true);
    await enqueueAgentRun(db, threadId, messageId);
    await drainFbAgentRuns(db, deps(db, calls, alerts));
    await setSettings(db, ['kill_switch'], false);
    await db`UPDATE fb_threads SET mode = 'human' WHERE id = ${threadId}`;
    await enqueueAgentRun(db, threadId, messageId);
    await drainFbAgentRuns(db, deps(db, calls, alerts));
    const off = await seedAccount(db, false);
    const t2 = await seedThread(db, off);
    await enqueueAgentRun(db, t2.threadId, t2.messageId);
    await drainFbAgentRuns(db, deps(db, calls, alerts));
    expect((await runs(db)).map((r) => [r.outcome, r.error])).toEqual([
      ['noop', 'The kill switch is on.'], ['noop', 'A person has the thread.'], ['noop', "The account's agent is off."],
    ]);
    expect(calls).toEqual([]);
  });

  it('a send refused inside the transaction leaves the thread untouched and the run as error', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId);
    await drainFbAgentRuns(db, deps(db, calls, alerts, {}, { refuseSend: true }));
    expect((await runs(db))[0]).toMatchObject({ state: 'done', outcome: 'error', error: 'A person has taken this thread over.' });
  });

  it('at the daily cap, runs hand off with the budget reason', async () => {
    await setSettings(db, ['agent', 'daily_spend_usd'], 0);
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId);
    await drainFbAgentRuns(db, deps(db, calls, alerts));
    const [r] = await runs(db);
    expect(r).toMatchObject({ outcome: 'handoff', cost_usd: 0 });
    expect(r!.decision!.handoff_reason).toBe("The agent's daily budget is used up");
    expect(calls.find((c) => c.fn === 'flagHuman')!.args[0]).toBe("The agent's daily budget is used up");
  });

  it('a candidate profile runs in shadow and never touches the thread', async () => {
    await db`
      INSERT INTO fb_agent_profiles (name, version, state, prompts, skills, rules, models)
      SELECT name, 2, 'candidate', prompts, skills, rules, models FROM fb_agent_profiles WHERE state = 'active'`;
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId);
    expect(await drainFbAgentRuns(db, deps(db, calls, alerts))).toBe(1);
    const rs = await runs(db);
    expect(rs.map((r) => [r.shadow, r.state, r.outcome])).toEqual([[false, 'done', 'send'], [true, 'done', 'send']]);
    expect(rs[1]!.profile_id).not.toBe(rs[0]!.profile_id);
    expect(calls.filter((c) => c.fn === 'queueOutbound')).toHaveLength(1);
  });

  it('the circuit breaker turns the agent off after consecutive blocks and alerts managers', async () => {
    await setSettings(db, ['agent', 'circuit_breaker_failures'], 2);
    const script: Script = { reply: 'Deal! {{offer}} and we pick up tomorrow.' };
    for (let i = 0; i < 2; i++) {
      const { threadId, messageId } = await seedThread(db, accountNo);
      await enqueueAgentRun(db, threadId, messageId);
      await drainFbAgentRuns(db, deps(db, calls, alerts, script));
    }
    expect((await runs(db)).map((r) => r.outcome)).toEqual(['blocked', 'blocked']);
    const [slot] = await db`SELECT agent_on FROM fleet_slots WHERE account_no = ${accountNo}`;
    expect(slot!.agent_on).toBe(false);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'fb_agent_circuit_breaker' })]);
    expect(alerts[0]!.reason).not.toMatch(/\b[45]\d\d\b/);
  });

  it('retakes a stale run and gives up after three attempts', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId);
    await db`UPDATE fb_agent_runs SET state = 'running', claimed_at = NOW() - INTERVAL '6 minutes', attempts = 1`;
    expect(await claimFbAgentRun(db)).toMatchObject({ thread_id: threadId, attempts: 2 });
    await db`UPDATE fb_agent_runs SET claimed_at = NOW() - INTERVAL '6 minutes', attempts = 3`;
    expect(await claimFbAgentRun(db)).toBeNull();
    expect((await runs(db))[0]).toMatchObject({ state: 'failed', outcome: 'error' });
  });

  it('does not claim a second run of a thread while one is under way', async () => {
    const { threadId, messageId } = await seedThread(db, accountNo);
    await enqueueAgentRun(db, threadId, messageId);
    expect(await claimFbAgentRun(db)).not.toBeNull();
    await enqueueAgentRun(db, threadId, messageId);
    expect(await claimFbAgentRun(db)).toBeNull();
  });

  it('startFbAgentLoop hands back stop()', () => {
    const loop = startFbAgentLoop(testEnv, deps(db, calls, alerts));
    expect(typeof loop.stop).toBe('function');
    loop.stop();
  });
});
