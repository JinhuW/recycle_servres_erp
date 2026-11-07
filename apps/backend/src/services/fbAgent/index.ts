// The seller agent's entry points (CONTRACTS §6.2): enqueueAgentRun from the
// inbox ingest, decide() for the loop and D2's replays, and the loop itself.
//
// The queue is fb_agent_runs, on the poAiReview pattern: claimed with SKIP
// LOCKED, retaken when its runner died, given up after three attempts. The
// model calls happen outside any transaction; the decision and everything it
// does to the thread are written in one.

import type { AgentDecision, AgentInput, FbAgentProfile, FbSellerSettings, FbThreadSnapshot } from '@recycle-erp/shared';
import type { Sql } from 'postgres';
import { getDb, type SqlLike } from '../../db';
import type { Env } from '../../types';
import { openRouterChatJson } from '../../ai/openrouter';
import { marketFor, partNumberCandidates } from '../../lib/fbOffer';
import { alertManagers } from '../../lib/fbSellerAlert';
import { log } from '../../lib/log';
import { loadFbSellerSettings } from '../fbConfig';
import * as fbThreads from '../fbThreads';
import { Budget } from '../poAiReview';
import { AgentBudgetError, decide } from './runtime';
import type { AgentLlm } from './types';

export { decide, AgentBudgetError } from './runtime';
export { agentRegistry } from './registry';
export type { AgentLlm, AgentRule, AgentSkill, RuleContext, SkillContext } from './types';

const agentLog = log.child({ module: 'fb-agent' });

/** Queues a run for the thread, or points the one already waiting at the newer message. */
export async function enqueueAgentRun(tx: SqlLike, threadId: number, triggerMessageId: number): Promise<void> {
  await tx`
    WITH waiting AS (
      UPDATE fb_agent_runs SET trigger_message_id = ${triggerMessageId}
      WHERE thread_id = ${threadId} AND state = 'queued' AND NOT shadow AND eval_run_id IS NULL
      RETURNING id
    )
    INSERT INTO fb_agent_runs (thread_id, trigger_message_id)
    SELECT ${threadId}, ${triggerMessageId} WHERE NOT EXISTS (SELECT 1 FROM waiting)
  `;
}

// ── What the loop calls, swappable in tests ─────────────────────────────────

export type AgentThreads = Pick<typeof fbThreads,
  'loadThreadSnapshot' | 'queueOutbound' | 'flagHuman' | 'setStage' | 'recordOffer' | 'recordExtract'>;

export type AgentDeps = {
  threads: AgentThreads;
  alert: typeof alertManagers;
  /** The model transport before the budget is put around it. */
  llm: AgentLlm;
  now: () => Date;
};

/** The OpenRouter-backed AgentLlm (CONTRACTS §9), for the loop and D2's eval runner. */
export function agentLlmFor(env: Env): AgentLlm {
  return async (req) => {
    const { json, usage } = await openRouterChatJson(env, { ...req, schemaName: 'agent' });
    return {
      json,
      usage: { model: req.model, prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, cost_usd: usage.costUsd },
    };
  };
}

function defaultDeps(env: Env): AgentDeps {
  return { threads: fbThreads, alert: alertManagers, llm: agentLlmFor(env), now: () => new Date() };
}

/** Puts the day's remaining spend around a transport; past it every call throws AgentBudgetError. */
export function budgeted(llm: AgentLlm, budget: Budget): AgentLlm {
  return async (req) => {
    if (!(await budget.begin())) throw new AgentBudgetError();
    try {
      const r = await llm(req);
      budget.add({ promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens, costUsd: r.usage.cost_usd });
      return r;
    } finally {
      budget.end();
    }
  };
}

// ── Building one run's input ────────────────────────────────────────────────

type ProfileRow = FbAgentProfile;

async function profileById(sql: SqlLike, id: number): Promise<ProfileRow | null> {
  const [row] = await sql<ProfileRow[]>`
    SELECT id::int AS id, name, version, state, prompts, skills, rules, models, notes
    FROM fb_agent_profiles WHERE id = ${id}`;
  return row ?? null;
}

async function profileInState(sql: SqlLike, state: 'active' | 'candidate'): Promise<ProfileRow | null> {
  const [row] = await sql<ProfileRow[]>`
    SELECT id::int AS id, name, version, state, prompts, skills, rules, models, notes
    FROM fb_agent_profiles WHERE state = ${state}`;
  return row ?? null;
}

/** AgentInput from a snapshot: the Market rows for every part number the seller could have meant. */
export async function buildAgentInput(
  sql: SqlLike, snap: FbThreadSnapshot, settings: FbSellerSettings, now: Date,
): Promise<AgentInput> {
  const messages = snap.messages
    .filter((m): m is typeof m & { seq: number } => m.seq !== null)
    .map((m) => ({ seq: m.seq, direction: m.direction, author: m.author, body: m.body, has_image: m.has_image }));
  const stored = 'items' in snap.thread.extracted ? snap.thread.extracted.items : [];
  const candidates = [
    ...partNumberCandidates(messages.filter((m) => m.direction !== 'out').map((m) => m.body)),
    ...stored.map((it) => it.part_number ?? '').filter(Boolean),
  ];
  return {
    thread: {
      id: snap.thread.id, stage: snap.thread.stage, round: snap.thread.round,
      offer_usd: snap.thread.offer_usd, listing_title: snap.thread.listing_title,
    },
    messages,
    market: await marketFor(sql, candidates),
    settings: settings.offer,
    now: now.toISOString(),
  };
}

/**
 * Spend today, every run counted (live, shadow, eval), on the calendar day in
 * the seller's own time zone (CONTRACTS §9). The loop and D2's eval runner
 * hold agent.daily_spend_usd against it.
 */
export async function agentSpentTodayUsd(sql: SqlLike, settings: FbSellerSettings): Promise<number> {
  const tz = settings.active_hours.tz;
  const [row] = await sql<{ spent: number }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::float AS spent FROM fb_agent_runs
    WHERE created_at >= (date_trunc('day', NOW() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
  return row?.spent ?? 0;
}

function totals(d: AgentDecision) {
  return {
    model: d.usage[0]?.model ?? null,
    prompt_tokens: d.usage.reduce((s, u) => s + u.prompt_tokens, 0),
    completion_tokens: d.usage.reduce((s, u) => s + u.completion_tokens, 0),
    cost_usd: d.usage.reduce((s, u) => s + u.cost_usd, 0),
  };
}

// ── Applying a decision ─────────────────────────────────────────────────────

async function applyDecision(tx: SqlLike, deps: AgentDeps, threadId: number, runId: number, d: AgentDecision): Promise<void> {
  const t = deps.threads;
  if (d.outcome === 'send') {
    if (d.extract) await t.recordExtract(tx, threadId, d.extract);
    if (d.offer) await t.recordOffer(tx, threadId, { offerUsd: d.offer.offer_usd, ceilingUsd: d.offer.ceiling_usd, round: d.offer.round });
    if (d.stage) await t.setStage(tx, threadId, d.stage);
    await t.queueOutbound(tx, threadId, d.reply!, { author: 'agent', agentRunId: runId });
  } else if (d.outcome === 'handoff') {
    if (d.extract) await t.recordExtract(tx, threadId, d.extract);
    // The honest line goes out first: queueOutbound refuses once needs_human is set.
    if (d.reply) await t.queueOutbound(tx, threadId, d.reply, { author: 'agent', agentRunId: runId });
    await t.flagHuman(tx, threadId, d.handoff_reason ?? 'The agent handed this conversation to a person.', { rules_fired: d.rules_fired });
  } else if (d.outcome === 'blocked') {
    if (d.extract) await t.recordExtract(tx, threadId, d.extract);
    await t.flagHuman(tx, threadId, d.handoff_reason ?? "The agent's reply was blocked.", { failures: d.guard.failures });
  }
}

/**
 * Guard 8. Counts the account's latest sends and blocks; when the last
 * `circuit_breaker_failures` of them were all blocked or failed to send, the
 * account's agent goes off and managers hear why. Also for C's send-failure
 * path to call.
 */
export async function checkCircuitBreaker(
  tx: SqlLike, accountNo: number, settings: FbSellerSettings, alert: typeof alertManagers = alertManagers,
): Promise<boolean> {
  const n = settings.agent.circuit_breaker_failures;
  if (!(n > 0)) return false;
  const rows = await tx<{ failed: boolean }[]>`
    SELECT (r.outcome = 'blocked' OR EXISTS (
              SELECT 1 FROM fb_messages m WHERE m.agent_run_id = r.id AND m.send_state = 'failed')) AS failed
    FROM fb_agent_runs r JOIN fb_threads t ON t.id = r.thread_id
    WHERE t.account_no = ${accountNo} AND NOT r.shadow AND r.eval_run_id IS NULL
      AND r.state = 'done' AND r.outcome IN ('send','blocked')
    ORDER BY r.finished_at DESC NULLS LAST, r.id DESC
    LIMIT ${n}`;
  if (rows.length < n || !rows.every((r) => r.failed)) return false;
  const off = await tx`UPDATE fleet_slots SET agent_on = FALSE WHERE account_no = ${accountNo} AND agent_on RETURNING account_no`;
  if (off.length === 0) return false;
  await alert(tx, {
    kind: 'fb_agent_circuit_breaker',
    title: `Agent switched off on account #${accountNo}`,
    reason: `The agent's last ${n} replies on this account were blocked or failed to send, so it stopped answering there. Turn it back on from Leads ▸ Facebook once you have looked.`,
  });
  return true;
}

// ── One run ─────────────────────────────────────────────────────────────────

type ClaimedRun = { id: number; thread_id: number; trigger_message_id: number | null; attempts: number };

async function finishQuiet(sql: SqlLike, runId: number, why: string): Promise<void> {
  await sql`
    UPDATE fb_agent_runs SET state = 'done', outcome = 'noop', error = ${why}, finished_at = NOW()
    WHERE id = ${runId}`;
}

export async function runFbAgentRun(sql: Sql<{}>, deps: AgentDeps, run: ClaimedRun): Promise<void> {
  const settings = await loadFbSellerSettings(sql);
  const snap = await sql.begin((tx) => deps.threads.loadThreadSnapshot(tx, run.thread_id));
  const [slot] = snap.thread.account_no === null ? [] : await sql<{ agent_on: boolean; agent_profile_id: number | null }[]>`
    SELECT agent_on, agent_profile_id::int AS agent_profile_id FROM fleet_slots WHERE account_no = ${snap.thread.account_no}`;
  if (settings.kill_switch) return finishQuiet(sql, run.id, 'The kill switch is on.');
  if (!slot?.agent_on) return finishQuiet(sql, run.id, "The account's agent is off.");
  if (snap.thread.mode === 'human' || snap.thread.needs_human) return finishQuiet(sql, run.id, 'A person has the thread.');

  const profile = (slot.agent_profile_id !== null ? await profileById(sql, slot.agent_profile_id) : null)
    ?? await profileInState(sql, 'active');
  if (!profile) throw new Error('no active agent profile');

  const input = await buildAgentInput(sql, snap, settings, deps.now());
  await sql`
    UPDATE fb_agent_runs SET input = ${sql.json(input as never)}, profile_id = ${profile.id}
    WHERE id = ${run.id}`;

  const left = settings.agent.daily_spend_usd - await agentSpentTodayUsd(sql, settings);
  const budget = new Budget(left);
  const decision = await decide(input, profile, budgeted(deps.llm, budget));
  const sum = totals(decision);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE fb_agent_runs
      SET state = 'done', decision = ${tx.json(decision as never)}, outcome = ${decision.outcome},
          model = ${sum.model}, prompt_tokens = ${sum.prompt_tokens}, completion_tokens = ${sum.completion_tokens},
          cost_usd = ${sum.cost_usd}, error = NULL, finished_at = NOW()
      WHERE id = ${run.id}`;
    try {
      await tx.savepoint((sp) => applyDecision(sp, deps, run.thread_id, run.id, decision));
    } catch (e) {
      // The thread moved under the run (a person took it, the kill switch went
      // on): the decision stays on record and nothing reaches the thread.
      const msg = e instanceof Error ? e.message : String(e);
      await tx`UPDATE fb_agent_runs SET outcome = 'error', error = ${msg.slice(0, 500)} WHERE id = ${run.id}`;
      return;
    }
    if (decision.outcome === 'blocked' && snap.thread.account_no !== null) {
      await checkCircuitBreaker(tx, snap.thread.account_no, settings, deps.alert);
    }
  });

  // A candidate profile decides the same input on the side; it never touches the thread.
  const candidate = await profileInState(sql, 'candidate');
  if (candidate && candidate.id !== profile.id) {
    const shadow = await decide(input, candidate, budgeted(deps.llm, budget));
    const s = totals(shadow);
    await sql`
      INSERT INTO fb_agent_runs (thread_id, trigger_message_id, profile_id, shadow, state, attempts, claimed_at,
                                 input, decision, outcome, model, prompt_tokens, completion_tokens, cost_usd, finished_at)
      VALUES (${run.thread_id}, ${run.trigger_message_id}, ${candidate.id}, TRUE, 'done', 1, NOW(),
              ${sql.json(input as never)}, ${sql.json(shadow as never)}, ${shadow.outcome},
              ${s.model}, ${s.prompt_tokens}, ${s.completion_tokens}, ${s.cost_usd}, NOW())`;
  }
}

// ── The loop ────────────────────────────────────────────────────────────────

const TICK_MS = 10_000;
const STALE_AFTER = '5 minutes';
const MAX_ATTEMPTS = 3;
const MAX_PER_TICK = 10;

/** The oldest waiting run whose thread has no other run under way, or one whose runner died. */
export async function claimFbAgentRun(sql: SqlLike): Promise<ClaimedRun | null> {
  await sql`
    UPDATE fb_agent_runs SET state = 'failed', outcome = 'error', finished_at = NOW(),
           error = 'gave up after ' || attempts || ' attempts'
    WHERE state = 'running' AND claimed_at < NOW() - ${STALE_AFTER}::interval
      AND attempts >= ${MAX_ATTEMPTS} AND NOT shadow AND eval_run_id IS NULL`;
  const [row] = await sql<ClaimedRun[]>`
    UPDATE fb_agent_runs SET state = 'running', claimed_at = NOW(), attempts = attempts + 1
    WHERE id = (
      SELECT r.id FROM fb_agent_runs r
      WHERE NOT r.shadow AND r.eval_run_id IS NULL AND r.thread_id IS NOT NULL
        AND (r.state = 'queued' OR (r.state = 'running' AND r.claimed_at < NOW() - ${STALE_AFTER}::interval))
        AND NOT EXISTS (
          SELECT 1 FROM fb_agent_runs o
          WHERE o.thread_id = r.thread_id AND o.id <> r.id AND o.state = 'running' AND NOT o.shadow
            AND o.claimed_at >= NOW() - ${STALE_AFTER}::interval)
      ORDER BY r.created_at, r.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id::int AS id, thread_id::int AS thread_id, trigger_message_id::int AS trigger_message_id, attempts`;
  return row ?? null;
}

export async function drainFbAgentRuns(
  sql: Sql<{}>, deps: AgentDeps, max = MAX_PER_TICK, stopping: () => boolean = () => false,
): Promise<number> {
  let ran = 0;
  for (; ran < max && !stopping(); ran++) {
    const run = await claimFbAgentRun(sql);
    if (!run) break;
    try {
      await runFbAgentRun(sql, deps, run);
    } catch (e) {
      agentLog.child({ runId: run.id, threadId: run.thread_id }).error('fb agent run failed', e as Error);
      await sql`
        UPDATE fb_agent_runs SET state = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
               outcome = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'error' END,
               finished_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NOW() END,
               error = ${String((e as Error).message ?? e).slice(0, 500)}
        WHERE id = ${run.id} AND state = 'running' AND attempts = ${run.attempts}`;
    }
  }
  return ran;
}

export function startFbAgentLoop(env: Env, deps?: AgentDeps): { stop: () => void } {
  const sql = getDb(env);
  const d = deps ?? defaultDeps(env);
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await drainFbAgentRuns(sql, d, MAX_PER_TICK, () => stopped);
    } catch (e) {
      agentLog.error('fb agent loop failed', e);
    } finally {
      busy = false;
    }
  };
  const handle = setInterval(() => void tick(), TICK_MS);
  handle.unref?.();
  return { stop() { stopped = true; clearInterval(handle); } };
}
