import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  FbAgentEvalCase, FbAgentEvalRun, FbAgentEvalRunDetail, FbAgentProfileRow, FbEvalCompare, FbShadowPage, FbThreadSnapshot,
} from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { stubDecide, stubLlm, type Canned } from './fixtures/fb-agent/stubAgent';

// Shadow listing, replay cases and eval runs (CONTRACTS §6.7). The agent
// runtime and the thread service belong to other workstreams; both are
// replaced here by fakes with their contract signatures. Every thread write
// is a spy, so a test can prove nothing here calls one.

const h = vi.hoisted(() => ({
  snapshot: null as FbThreadSnapshot | null,
  llm: null as unknown,
  spent: 0,
  writes: [] as string[],
}));

vi.mock('../src/services/fbThreads', () => {
  const write = (name: string) => async () => { h.writes.push(name); throw new Error(`${name} must not be called`); };
  return {
    loadThreadSnapshot: async () => h.snapshot,
    queueOutbound: write('queueOutbound'),
    flagHuman: write('flagHuman'),
    setStage: write('setStage'),
    recordOffer: write('recordOffer'),
    recordExtract: write('recordExtract'),
  };
});

vi.mock('../src/services/fbAgent', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/fbAgent')>();
  const { stubDecide: decide } = await import('./fixtures/fb-agent/stubAgent');
  return {
    ...real,
    decide,
    agentLlmFor: () => h.llm,
    agentSpentTodayUsd: async () => h.spent,
  };
});

const CANNED: Record<string, Canned> = {
  '16x M393A8G40AB2-CWE 64GB, pulled from R650s.': {
    extract: { items: [{ part_number: 'M393A8G40AB2-CWE', description: '64GB RDIMM', qty: 16 }], intent: 'offer_items' },
  },
  'Ok, deal.': { extract: { agreeing: true, intent: 'agree' } },
};

let cookies: Record<string, string>;
beforeEach(async () => {
  await resetDb();
  cookies = (await loginAs(ALEX)).cookies;
  h.llm = stubLlm(CANNED);
  h.spent = 0;
  h.writes = [];
});

const call = <T>(method: string, path: string, body?: unknown) => api<T>(method, `/api/fb-agent${path}`, { cookies, body });

async function activeProfile(): Promise<FbAgentProfileRow> {
  return (await call<{ rows: FbAgentProfileRow[] }>('GET', '/profiles')).body.rows.find((p) => p.state === 'active')!;
}

async function makeThread(lastBody: string) {
  const db = getTestDb();
  const [t] = await db<{ id: string }[]>`
    INSERT INTO fb_threads (fb_thread_id, seller_name, listing_title, stage)
    VALUES ('t-1', 'Test Seller', 'We buy server RAM', 'screening') RETURNING id`;
  const tid = Number(t!.id);
  const [m1] = await db<{ id: string }[]>`
    INSERT INTO fb_messages (thread_id, seq, direction, author, body) VALUES (${tid}, 1, 'in', 'seller', 'Hi, I have RAM.') RETURNING id`;
  await db`INSERT INTO fb_messages (thread_id, seq, direction, author, body, send_state) VALUES (${tid}, 2, 'out', 'agent', 'Which part numbers?', 'sent')`;
  const [m3] = await db<{ id: string }[]>`
    INSERT INTO fb_messages (thread_id, seq, direction, author, body) VALUES (${tid}, 3, 'in', 'seller', ${lastBody}) RETURNING id`;
  h.snapshot = {
    thread: { id: tid, account_no: null, stage: 'screening', mode: 'agent', needs_human: false, round: 0, offer_usd: null, ceiling_usd: null, listing_title: 'We buy server RAM', extracted: {} },
    messages: [
      { id: Number(m1!.id), seq: 1, direction: 'in', author: 'seller', body: 'Hi, I have RAM.', has_image: false },
      { id: 0, seq: 2, direction: 'out', author: 'agent', body: 'Which part numbers?', has_image: false },
      { id: Number(m3!.id), seq: 3, direction: 'in', author: 'seller', body: lastBody, has_image: false },
      // An outbound not yet seen to land has no place in the conversation.
      { id: 0, seq: null, direction: 'out', author: 'agent', body: 'queued reply', has_image: false },
    ],
  };
  return { tid, triggerId: Number(m3!.id) };
}

async function liveRun(tid: number, triggerId: number, profileId: number, maxBuy: number, extra: { shadow?: boolean; outcome?: string } = {}) {
  const db = getTestDb();
  const input = {
    market: [{ canon: 'M393A8G40AB2CWE', part_number: 'M393A8G40AB2-CWE', label: 'Samsung 64GB', max_buy_unit: maxBuy, price_at: '2026-11-01T00:00:00.000Z' }],
  };
  const [r] = await db<{ id: string }[]>`
    INSERT INTO fb_agent_runs (thread_id, trigger_message_id, profile_id, shadow, state, input, decision, outcome)
    VALUES (${tid}, ${triggerId}, ${profileId}, ${extra.shadow ?? false}, 'done', ${db.json(input)},
            ${db.json({ outcome: extra.outcome ?? 'send' })}, ${extra.outcome ?? 'send'})
    RETURNING id`;
  return Number(r!.id);
}

async function waitFor(id: number): Promise<FbAgentEvalRunDetail> {
  for (let i = 0; i < 200; i++) {
    const r = await call<FbAgentEvalRunDetail>('GET', `/evals/${id}`);
    if (r.body.state === 'done' || r.body.state === 'failed') return r.body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('eval did not finish');
}

async function evalOf(profileId: number): Promise<FbAgentEvalRunDetail> {
  const r = await call<FbAgentEvalRun>('POST', '/evals', { profile_id: profileId });
  expect(r.status).toBe(202);
  return waitFor(r.body.id);
}

async function threadTables() {
  const db = getTestDb();
  const [r] = await db<{ t: string; m: string; e: string; tasks: string; live: string }[]>`
    SELECT (SELECT md5(string_agg(row_to_json(t)::text, ',' ORDER BY id)) FROM fb_threads t) AS t,
           (SELECT md5(string_agg(row_to_json(m)::text, ',' ORDER BY id)) FROM fb_messages m) AS m,
           (SELECT COUNT(*) FROM fb_thread_events) AS e,
           (SELECT COUNT(*) FROM fleet_tasks) AS tasks,
           (SELECT COUNT(*) FROM fb_agent_runs WHERE eval_run_id IS NULL) AS live`;
  return r;
}

describe('saved cases replay', { timeout: 60_000 }, () => {
  it('freezes the thread with the Market rows it was priced with; replays are identical and ignore later Market moves', async () => {
    const p = await activeProfile();
    const { tid, triggerId } = await makeThread('16x M393A8G40AB2-CWE 64GB, pulled from R650s.');
    await liveRun(tid, triggerId, p.id, 62);

    const { saveCaseFromThread } = await import('../src/services/fbAgentEval');
    const { caseId } = await getTestDb().begin((tx) => saveCaseFromThread(tx, tid, 'RAM lot', { handoff: false, max_offer_usd: 992 }));
    const [saved] = (await call<{ rows: FbAgentEvalCase[] }>('GET', '/cases')).body.rows;
    expect(saved).toMatchObject({ id: caseId, name: 'RAM lot', source_thread_id: tid });
    expect(saved!.input.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(saved!.input.market[0]!.max_buy_unit).toBe(62);
    expect(saved!.input.settings).toEqual({ opening_pct: 70, step_pct: 10, max_rounds: 3, price_max_age_days: 30 });

    const first = await evalOf(p.id);
    // The Market moves: a newer run prices the same part far higher.
    await liveRun(tid, triggerId, p.id, 500);
    const second = await evalOf(p.id);

    expect(first.state).toBe('done');
    expect(first.results).toHaveLength(1);
    const [a, b] = [first.results[0]!, second.results[0]!];
    expect(a.decision).toEqual(b.decision);
    expect(a.decision!.offer).toEqual({ offer_usd: 694, ceiling_usd: 992, round: 0 });
    expect(a).toMatchObject({ passed: true, why: [] });
    expect(first).toMatchObject({ cases: 1, passed: 1, failed: 0 });
    expect(first.cost_usd).toBeCloseTo(0.002);

    const cmp = (await call<FbEvalCompare>('GET', `/evals/compare?a=${first.id}&b=${second.id}`)).body;
    expect(cmp.changed).toBe(0);
    expect(cmp.rows[0]).toMatchObject({ case_id: caseId, changed: false, changes: [] });
  });
});

describe('eval runs', { timeout: 60_000 }, () => {
  it('a candidate run in shadow or eval never writes to a thread or queues a message', async () => {
    const p = await activeProfile();
    const { tid, triggerId } = await makeThread('Ok, deal.');
    await liveRun(tid, triggerId, p.id, 62);
    expect((await call<{ added: number }>('POST', '/cases/seed')).body.added).toBeGreaterThan(10);
    const cand = (await call<FbAgentProfileRow>('POST', `/profiles/${p.id}/draft`)).body;
    await call('POST', `/profiles/${cand.id}/promote`, { to: 'candidate' });
    await liveRun(tid, triggerId, cand.id, 62, { shadow: true, outcome: 'handoff' });

    const before = await threadTables();
    const ev = await evalOf(cand.id);
    expect(ev.state).toBe('done');
    expect(ev.results.every((r) => r.state === 'done')).toBe(true);
    await call<FbShadowPage>('GET', `/shadow?profile_id=${cand.id}`);
    expect(await threadTables()).toEqual(before);
    expect(h.writes).toEqual([]);
    // Eval runs carry no thread.
    const [n] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fb_agent_runs WHERE eval_run_id = ${ev.id} AND thread_id IS NOT NULL`;
    expect(n!.n).toBe(0);
  });

  it('pairs each shadow run with the live run for the same trigger', async () => {
    const p = await activeProfile();
    const { tid, triggerId } = await makeThread('Ok, deal.');
    const cand = (await call<FbAgentProfileRow>('POST', `/profiles/${p.id}/draft`)).body;
    await call('POST', `/profiles/${cand.id}/promote`, { to: 'candidate' });
    const live = await liveRun(tid, triggerId, p.id, 62, { outcome: 'send' });
    const shadow = await liveRun(tid, triggerId, cand.id, 62, { shadow: true, outcome: 'handoff' });
    const lone = await liveRun(tid, null as unknown as number, cand.id, 62, { shadow: true, outcome: 'noop' });

    const page = (await call<FbShadowPage>('GET', `/shadow?profile_id=${cand.id}`)).body;
    expect(page.rows.map((r) => r.shadow.id)).toEqual([lone, shadow]);
    expect(page.rows[1]).toMatchObject({ trigger_message_id: triggerId, thread_id: tid, trigger_body: 'Ok, deal.' });
    expect(page.rows[1]!.shadow).toMatchObject({ outcome: 'handoff', shadow: true, profile_id: cand.id });
    expect(page.rows[1]!.live).toMatchObject({ id: live, outcome: 'send', shadow: false, profile_id: p.id });
    expect(page.rows[0]!.live).toBeNull();
    expect(page.next).toBeNull();
    expect((await call<FbShadowPage>('GET', `/shadow?profile_id=${p.id}`)).body.rows).toEqual([]);
    expect((await call<FbShadowPage>(`GET`, `/shadow?cursor=${shadow}`)).body.rows).toEqual([]);
  });

  it('compare reports changed cases and grades against the expectation', async () => {
    const p = await activeProfile();
    const input = (last: string, round = 0) => ({
      thread: { id: null, stage: 'screening', round, offer_usd: null, listing_title: 'x' },
      messages: [{ seq: 1, direction: 'in', author: 'seller', body: last, has_image: false }],
      market: [{ canon: 'M393A8G40AB2CWE', part_number: 'M393A8G40AB2-CWE', label: 'Samsung 64GB', max_buy_unit: 62, price_at: '2026-11-01T00:00:00.000Z' }],
      settings: { opening_pct: 70, step_pct: 10, max_rounds: 3, price_max_age_days: 30 },
      now: '2026-11-07T17:00:00.000Z',
    });
    const mk = async (name: string, i: unknown, expected: unknown) =>
      (await call<FbAgentEvalCase>('POST', '/cases', { name, input: i, expected })).body.id;
    const offer = await mk('offer', input('16x M393A8G40AB2-CWE 64GB, pulled from R650s.'), { handoff: false, max_offer_usd: 700 });
    const close = await mk('close', input('Ok, deal.'), { handoff: true, reason_kind: 'closing' });
    const keyword = await mk('kw', input('From my old job, no receipt.'), { handoff: true, reason_kind: 'keyword' });

    const a = await evalOf(p.id);
    expect(a.results.map((r) => [r.case_name, r.passed])).toEqual([['offer', true], ['close', true], ['kw', false]]);
    expect(a.results[2]!.why[0]).toMatch(/hand-off/);

    // Version 2: a keyword pattern, and a later opening offer.
    const v2 = (await call<FbAgentProfileRow>('POST', `/profiles/${p.id}/draft`)).body;
    await call('PATCH', `/profiles/${v2.id}`, { rules: v2.rules.map((r) => r.kind === 'keyword' ? { ...r, params: { patterns: ['no receipt'] } } : r) });
    await getTestDb()`UPDATE fb_agent_eval_cases SET input = jsonb_set(input, '{thread,round}', '1') WHERE id = ${offer}`;
    const b = await evalOf(v2.id);

    expect((await call<{ rows: FbAgentEvalRun[] }>('GET', '/evals')).body.rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await call<{ rows: FbAgentEvalRun[] }>('GET', `/evals?profile_id=${v2.id}`)).body.rows.map((r) => r.id)).toEqual([b.id]);

    const cmp = (await call<FbEvalCompare>('GET', `/evals/compare?a=${a.id}&b=${b.id}`)).body;
    const byCase = Object.fromEntries(cmp.rows.map((r) => [r.case_id, r]));
    expect(cmp.changed).toBe(2);
    expect(byCase[close]).toMatchObject({ changed: false, changes: [] });
    expect(byCase[keyword]).toMatchObject({ changed: true, a: { handoff: false, passed: false }, b: { handoff: true, reason_kind: 'keyword', passed: true } });
    expect(byCase[keyword]!.changes).toEqual(['handoff', 'reason_kind', 'reply', 'passed']);
    // Round 1 opens at 80% of 992: over the 700 the case allows.
    expect(byCase[offer]).toMatchObject({ changed: true, a: { offer_usd: 694, passed: true }, b: { offer_usd: 794, passed: false } });
    expect(byCase[offer]!.changes).toEqual(['offer_usd', 'reply', 'passed']);

    // An archived case is not in the next eval.
    await call('DELETE', `/cases/${keyword}`);
    expect((await evalOf(p.id)).results.map((r) => r.case_id)).toEqual([offer, close]);
  });

  it('stops as failed, in words, when the day budget is used up', async () => {
    const p = await activeProfile();
    await call('POST', '/cases/seed');
    h.spent = 5;
    const ev = await evalOf(p.id);
    expect(ev.state).toBe('failed');
    expect(ev.error).toMatch(/daily budget is used up/);
    expect(ev.results.every((r) => r.passed === false)).toBe(true);
    expect((h.llm as { calls: number }).calls).toBe(0);
  });

  it('seeds once, and refuses a malformed case with the field named', async () => {
    const first = (await call<{ added: number }>('POST', '/cases/seed')).body.added;
    expect(first).toBeGreaterThanOrEqual(12);
    expect((await call<{ added: number }>('POST', '/cases/seed')).body.added).toBe(0);
    const bad = await call<{ field: string }>('POST', '/cases', { name: 'x', input: { thread: {}, messages: [] }, expected: { handoff: true } });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('input.messages');
    const noProfile = await call<{ error: string }>('POST', '/evals', { profile_id: 999999 });
    expect(noProfile.status).toBe(404);
  });
});
