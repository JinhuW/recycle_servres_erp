import type {
  AgentDecision,
  AgentInput,
  EvalExpectation,
  FbAgentEvalCase,
  FbAgentEvalRun,
  FbAgentEvalRunDetail,
  FbAgentProfile,
  FbAgentRunBrief,
  FbEvalCaseResult,
  FbEvalCaseSummary,
  FbEvalCompare,
  FbEvalCompareRow,
  FbSellerSettings,
  FbShadowPage,
} from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { log } from '../lib/log';
import type { AgentLlm } from './fbAgent';
import { loadFbSellerSettings } from './fbConfig';
import { FbAgentRefusal, asProfile, getProfile } from './fbAgentProfiles';
import { SEED_CASES } from './fbAgentSeedCases';
import { loadThreadSnapshot } from './fbThreads';

// Replay cases and eval runs for agent profiles (CONTRACTS §6.4, §6.7). A case
// holds a frozen AgentInput, Market snapshot and offer settings included, so it
// replays the same tomorrow whatever the Market does. An eval run is one
// `decide` per case, stored as fb_agent_runs rows with no thread: nothing here
// writes to a thread or queues a message.

const BUDGET_USED = "The agent's daily budget is used up, so the remaining cases did not run.";

// ─── Validation ───────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(field: string, detail: string): never {
  throw new FbAgentRefusal(400, 'invalid', detail, field);
}

export function readExpectation(v: unknown, field = 'expected'): EvalExpectation {
  if (!isObj(v) || typeof v.handoff !== 'boolean') invalid(`${field}.handoff`, 'The expectation needs handoff: true or false.');
  const out: EvalExpectation = { handoff: v.handoff };
  if (v.reason_kind !== undefined && v.reason_kind !== null) {
    if (typeof v.reason_kind !== 'string' || !v.reason_kind) invalid(`${field}.reason_kind`, 'reason_kind must be a rule kind.');
    out.reason_kind = v.reason_kind;
  }
  if (v.max_offer_usd !== undefined && v.max_offer_usd !== null) {
    if (typeof v.max_offer_usd !== 'number' || !(v.max_offer_usd >= 0)) invalid(`${field}.max_offer_usd`, 'max_offer_usd must be a number of dollars.');
    out.max_offer_usd = v.max_offer_usd;
  }
  if (v.must_not_contain !== undefined && v.must_not_contain !== null) {
    if (!Array.isArray(v.must_not_contain) || !v.must_not_contain.every((s) => typeof s === 'string' && s)) {
      invalid(`${field}.must_not_contain`, 'must_not_contain must be a list of text.');
    }
    out.must_not_contain = v.must_not_contain as string[];
  }
  return out;
}

export function readInput(v: unknown, field = 'input'): AgentInput {
  if (!isObj(v)) invalid(field, 'The input must be an AgentInput object.');
  if (!isObj(v.thread)) invalid(`${field}.thread`, 'The input needs a thread.');
  if (!Array.isArray(v.messages) || v.messages.length === 0) invalid(`${field}.messages`, 'The input needs at least one message.');
  for (let i = 0; i < v.messages.length; i++) {
    const m = v.messages[i] as unknown;
    if (!isObj(m) || typeof m.body !== 'string' || !['in', 'out', 'unknown'].includes(m.direction as string)) {
      invalid(`${field}.messages[${i}]`, `Message ${i + 1} needs a direction (in, out or unknown) and a body.`);
    }
  }
  if (!Array.isArray(v.market)) invalid(`${field}.market`, 'The input needs a market list, empty if nothing matched.');
  if (!isObj(v.settings)) invalid(`${field}.settings`, 'The input needs the offer settings.');
  if (typeof v.now !== 'string' || Number.isNaN(Date.parse(v.now))) invalid(`${field}.now`, 'The input needs now as an ISO time.');
  return v as unknown as AgentInput;
}

// ─── Cases ────────────────────────────────────────────────────────────────────

type CaseRow = Omit<FbAgentEvalCase, 'id' | 'source_thread_id' | 'created_at' | 'archived_at'> & {
  id: string; source_thread_id: string | null; created_at: Date; archived_at: Date | null;
};

const toCase = (r: CaseRow): FbAgentEvalCase => ({
  id: Number(r.id), name: r.name, source_thread_id: r.source_thread_id === null ? null : Number(r.source_thread_id),
  input: r.input, expected: r.expected, created_by: r.created_by, created_at: r.created_at.toISOString(),
  archived_at: r.archived_at ? r.archived_at.toISOString() : null,
});

export async function listCases(sql: SqlLike, archived = false): Promise<FbAgentEvalCase[]> {
  const rows = await sql<CaseRow[]>`
    SELECT * FROM fb_agent_eval_cases WHERE (archived_at IS NOT NULL) = ${archived} ORDER BY id`;
  return rows.map(toCase);
}

export async function createCase(tx: SqlLike, c: { name: string; input: AgentInput; expected: EvalExpectation; sourceThreadId?: number | null },
  userId: string | null): Promise<FbAgentEvalCase> {
  const [r] = await tx<CaseRow[]>`
    INSERT INTO fb_agent_eval_cases (name, source_thread_id, input, expected, created_by)
    VALUES (${c.name}, ${c.sourceThreadId ?? null}, ${tx.json(c.input as never)}, ${tx.json(c.expected as never)}, ${userId})
    RETURNING *`;
  return toCase(r!);
}

export async function patchCase(tx: SqlLike, id: number, p: { name?: string; input?: AgentInput; expected?: EvalExpectation }): Promise<FbAgentEvalCase> {
  const [r] = await tx<CaseRow[]>`
    UPDATE fb_agent_eval_cases SET
      name = COALESCE(${p.name ?? null}, name),
      input = COALESCE(${p.input ? tx.json(p.input as never) : null}::jsonb, input),
      expected = COALESCE(${p.expected ? tx.json(p.expected as never) : null}::jsonb, expected)
    WHERE id = ${id} AND archived_at IS NULL RETURNING *`;
  if (!r) throw new FbAgentRefusal(404, 'not_found', 'There is no such case, or it is archived.');
  return toCase(r);
}

export async function archiveCase(tx: SqlLike, id: number): Promise<void> {
  const r = await tx`UPDATE fb_agent_eval_cases SET archived_at = COALESCE(archived_at, NOW()) WHERE id = ${id}`;
  if (r.count === 0) throw new FbAgentRefusal(404, 'not_found', 'There is no such case.');
}

/**
 * Freezes the thread's current AgentInput as a case: its messages and stage
 * now, today's offer settings, and the Market rows the agent last priced the
 * thread with (its newest live run's input), so a later Market move cannot
 * change the replay.
 */
export async function saveCaseFromThread(tx: SqlLike, threadId: number, name: string, expected: EvalExpectation): Promise<{ caseId: number }> {
  const snap = await loadThreadSnapshot(tx, threadId);
  const settings = await loadFbSellerSettings(tx);
  const [last] = await tx<{ input: AgentInput | null }[]>`
    SELECT input FROM fb_agent_runs
    WHERE thread_id = ${threadId} AND NOT shadow AND eval_run_id IS NULL AND input IS NOT NULL
    ORDER BY id DESC LIMIT 1`;
  const input: AgentInput = {
    thread: {
      id: snap.thread.id, stage: snap.thread.stage, round: snap.thread.round,
      offer_usd: snap.thread.offer_usd, listing_title: snap.thread.listing_title,
    },
    messages: snap.messages.filter((m) => m.seq !== null).map((m) => ({
      seq: m.seq as number, direction: m.direction, author: m.author, body: m.body, has_image: m.has_image,
    })),
    market: last?.input?.market ?? [],
    settings: settings.offer,
    now: new Date().toISOString(),
  };
  const c = await createCase(tx, { name, input: readInput(input), expected: readExpectation(expected), sourceThreadId: threadId }, null);
  return { caseId: c.id };
}

// ─── Grading ──────────────────────────────────────────────────────────────────

const isHandoff = (d: AgentDecision) => d.outcome === 'handoff' || d.outcome === 'blocked';

/** The rule kind a hand-off is down to: the first rule fired, or `guard` for a blocked reply. */
export function reasonKind(d: AgentDecision): string | null {
  if (d.rules_fired.length > 0) return d.rules_fired[0]!.kind;
  return d.outcome === 'blocked' ? 'guard' : null;
}

/** Why `d` misses `e`, in words; empty when it passes. */
export function grade(d: AgentDecision, e: EvalExpectation): string[] {
  const why: string[] = [];
  if (isHandoff(d) !== e.handoff) {
    why.push(e.handoff ? `Expected a hand-off; the agent chose ${d.outcome}.` : `Expected no hand-off; the agent chose ${d.outcome}.`);
  }
  if (e.reason_kind && !(d.rules_fired.some((r) => r.kind === e.reason_kind) || (e.reason_kind === 'guard' && d.outcome === 'blocked'))) {
    why.push(`Expected the ${e.reason_kind} rule to fire; fired: ${d.rules_fired.map((r) => r.kind).join(', ') || 'none'}.`);
  }
  if (e.max_offer_usd !== undefined && d.offer && d.offer.offer_usd > e.max_offer_usd) {
    why.push(`Offered $${d.offer.offer_usd}, above the expected most of $${e.max_offer_usd}.`);
  }
  const reply = (d.reply ?? '').toLowerCase();
  for (const s of e.must_not_contain ?? []) {
    if (reply.includes(s.toLowerCase())) why.push(`The reply contains "${s}".`);
  }
  return why;
}

// ─── Eval runs ────────────────────────────────────────────────────────────────

export type EvalDeps = {
  llm: AgentLlm;
  decide: (input: AgentInput, profile: FbAgentProfile, llm: AgentLlm) => Promise<AgentDecision>;
  spentToday: (sql: SqlLike, settings: FbSellerSettings) => Promise<number>;
};

type EvalRow = Omit<FbAgentEvalRun, 'id' | 'profile_id' | 'cost_usd' | 'created_at' | 'finished_at'> & {
  id: string; profile_id: string; cost_usd: string; created_at: Date; finished_at: Date | null;
};

const toEval = (r: EvalRow): FbAgentEvalRun => ({
  id: Number(r.id), profile_id: Number(r.profile_id), state: r.state, cases: r.cases, passed: r.passed, failed: r.failed,
  cost_usd: Number(r.cost_usd), created_by: r.created_by, created_at: r.created_at.toISOString(),
  finished_at: r.finished_at ? r.finished_at.toISOString() : null,
});

export async function listEvalRuns(sql: SqlLike, profileId: number | null, limit = 100): Promise<FbAgentEvalRun[]> {
  const rows = await sql<EvalRow[]>`
    SELECT * FROM fb_agent_eval_runs WHERE (${profileId}::bigint IS NULL OR profile_id = ${profileId})
    ORDER BY id DESC LIMIT ${limit}`;
  return rows.map(toEval);
}

/** Queues an eval of `profileId` with one queued run per live case, each holding the case's input as it is now. */
export async function createEvalRun(tx: SqlLike, profileId: number, userId: string | null): Promise<FbAgentEvalRun> {
  const p = await getProfile(tx, profileId);
  if (!p) throw new FbAgentRefusal(404, 'not_found', 'There is no such profile version.');
  const [n] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fb_agent_eval_cases WHERE archived_at IS NULL`;
  if (!n || n.n === 0) throw new FbAgentRefusal(409, 'no_cases', 'There are no cases to run; add or seed some first.');
  const [r] = await tx<EvalRow[]>`
    INSERT INTO fb_agent_eval_runs (profile_id, cases, created_by) VALUES (${profileId}, ${n.n}, ${userId}) RETURNING *`;
  await tx`
    INSERT INTO fb_agent_runs (profile_id, eval_run_id, eval_case_id, input)
    SELECT ${profileId}, ${r!.id}, id, input FROM fb_agent_eval_cases WHERE archived_at IS NULL ORDER BY id`;
  return toEval(r!);
}

type ResultRow = {
  run_id: string; case_id: string | null; case_name: string | null; expected: EvalExpectation | null;
  state: FbEvalCaseResult['state']; decision: AgentDecision | null; cost_usd: string | null; error: string | null;
};

async function loadResults(sql: SqlLike, evalRunId: number): Promise<FbEvalCaseResult[]> {
  const rows = await sql<ResultRow[]>`
    SELECT r.id AS run_id, r.eval_case_id AS case_id, c.name AS case_name, c.expected,
           r.state, r.decision, r.cost_usd, r.error
    FROM fb_agent_runs r LEFT JOIN fb_agent_eval_cases c ON c.id = r.eval_case_id
    WHERE r.eval_run_id = ${evalRunId} ORDER BY r.eval_case_id, r.id`;
  return rows.map((r) => {
    let passed: boolean | null = null;
    let why: string[] = [];
    if (r.state === 'failed') {
      passed = false;
      why = [r.error ?? 'The run failed.'];
    } else if (r.state === 'done' && r.decision) {
      why = r.expected ? grade(r.decision, r.expected) : [];
      passed = why.length === 0;
    }
    return {
      case_id: r.case_id === null ? 0 : Number(r.case_id), case_name: r.case_name ?? '(deleted case)',
      run_id: Number(r.run_id), state: r.state, decision: r.decision, passed, why,
      cost_usd: r.cost_usd === null ? null : Number(r.cost_usd), error: r.error,
    };
  });
}

/**
 * Runs every queued case of an eval, one `decide` each, then settles the
 * counts. Stops as failed when the day's agent budget is used up. Each case's
 * row is written on its own, so a crash leaves what ran readable.
 */
export async function runEval(sql: SqlLike, evalRunId: number, deps: EvalDeps): Promise<void> {
  const [ev] = await sql<{ profile_id: string }[]>`
    UPDATE fb_agent_eval_runs SET state = 'running' WHERE id = ${evalRunId} AND state = 'queued' RETURNING profile_id`;
  if (!ev) return;
  let stopped = false;
  try {
    const row = await getProfile(sql, Number(ev.profile_id));
    if (!row) throw new Error('The profile was deleted before the eval ran.');
    const profile = asProfile(row);
    const settings = await loadFbSellerSettings(sql);
    const queued = await sql<{ id: string; input: AgentInput }[]>`
      SELECT id, input FROM fb_agent_runs WHERE eval_run_id = ${evalRunId} AND state = 'queued' ORDER BY eval_case_id, id`;
    for (const run of queued) {
      if (await deps.spentToday(sql, settings) >= settings.agent.daily_spend_usd) {
        await sql`
          UPDATE fb_agent_runs SET state = 'failed', outcome = 'error', error = ${BUDGET_USED}, finished_at = NOW()
          WHERE eval_run_id = ${evalRunId} AND state = 'queued'`;
        stopped = true;
        break;
      }
      await sql`UPDATE fb_agent_runs SET state = 'running', attempts = attempts + 1, claimed_at = NOW() WHERE id = ${run.id}`;
      try {
        const d = await deps.decide(run.input, profile, deps.llm);
        const cost = d.usage.reduce((s, u) => s + u.cost_usd, 0);
        await sql`
          UPDATE fb_agent_runs SET state = 'done', decision = ${sql.json(d as never)}, outcome = ${d.outcome},
            model = ${d.usage[d.usage.length - 1]?.model ?? profile.models.reply},
            prompt_tokens = ${d.usage.reduce((s, u) => s + u.prompt_tokens, 0)},
            completion_tokens = ${d.usage.reduce((s, u) => s + u.completion_tokens, 0)},
            cost_usd = ${cost}, finished_at = NOW()
          WHERE id = ${run.id}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await sql`
          UPDATE fb_agent_runs SET state = 'failed', outcome = 'error', error = ${`The case could not run: ${msg}`}, finished_at = NOW()
          WHERE id = ${run.id}`;
      }
    }
  } catch (e) {
    log.error('fb agent eval run failed', { evalRunId, error: e instanceof Error ? e.message : String(e) });
    await sql`
      UPDATE fb_agent_runs SET state = 'failed', outcome = 'error', error = ${`The eval stopped: ${e instanceof Error ? e.message : String(e)}`},
        finished_at = NOW()
      WHERE eval_run_id = ${evalRunId} AND state IN ('queued', 'running')`;
    stopped = true;
  }
  const results = await loadResults(sql, evalRunId);
  const cost = results.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  await sql`
    UPDATE fb_agent_eval_runs SET state = ${stopped ? 'failed' : 'done'},
      passed = ${results.filter((r) => r.passed === true).length}, failed = ${results.filter((r) => r.passed === false).length},
      cost_usd = ${cost}, finished_at = NOW()
    WHERE id = ${evalRunId}`;
}

async function mustEval(sql: SqlLike, id: number): Promise<FbAgentEvalRun> {
  const [r] = await sql<EvalRow[]>`SELECT * FROM fb_agent_eval_runs WHERE id = ${id}`;
  if (!r) throw new FbAgentRefusal(404, 'not_found', 'There is no such eval run.');
  return toEval(r);
}

/** An eval with each case graded against its expectation as it reads now, so fixing an expectation re-grades old runs. */
export async function evalDetail(sql: SqlLike, id: number): Promise<FbAgentEvalRunDetail> {
  const ev = await mustEval(sql, id);
  const p = await getProfile(sql, ev.profile_id);
  const results = await loadResults(sql, id);
  const firstError = results.find((r) => r.state === 'failed')?.error ?? null;
  return {
    ...ev,
    passed: results.filter((r) => r.passed === true).length,
    failed: results.filter((r) => r.passed === false).length,
    profile: { id: ev.profile_id, name: p?.name ?? '', version: p?.version ?? 0 },
    error: ev.state === 'failed' ? firstError : null,
    results,
  };
}

function summary(r: FbEvalCaseResult): FbEvalCaseSummary | null {
  if (!r.decision) return r.state === 'failed' ? { handoff: false, reason_kind: null, offer_usd: null, reply: null, passed: false } : null;
  return {
    handoff: isHandoff(r.decision), reason_kind: reasonKind(r.decision),
    offer_usd: r.decision.offer?.offer_usd ?? null, reply: r.decision.reply, passed: r.passed,
  };
}

const COMPARED = ['handoff', 'reason_kind', 'offer_usd', 'reply', 'passed'] as const;

/** Two eval runs side by side, case by case. */
export async function compareEvals(sql: SqlLike, aId: number, bId: number): Promise<FbEvalCompare> {
  const [a, b] = [await mustEval(sql, aId), await mustEval(sql, bId)];
  const [ra, rb] = [await loadResults(sql, aId), await loadResults(sql, bId)];
  const ids = [...new Set([...ra, ...rb].map((r) => r.case_id))].sort((x, y) => x - y);
  const rows: FbEvalCompareRow[] = ids.map((caseId) => {
    const xa = ra.find((r) => r.case_id === caseId);
    const xb = rb.find((r) => r.case_id === caseId);
    const sa = xa ? summary(xa) : null;
    const sb = xb ? summary(xb) : null;
    const changes = !sa || !sb ? (sa || sb ? ['present'] : []) : COMPARED.filter((k) => sa[k] !== sb[k]);
    return { case_id: caseId, case_name: (xa ?? xb)!.case_name, a: sa, b: sb, changed: changes.length > 0, changes: [...changes] };
  });
  return { a, b, rows, changed: rows.filter((r) => r.changed).length };
}

// ─── Shadow ───────────────────────────────────────────────────────────────────

type BriefRow = {
  id: string; profile_id: string | null; shadow: boolean; state: FbAgentRunBrief['state']; outcome: FbAgentRunBrief['outcome'];
  decision: AgentDecision | null; cost_usd: string | null; error: string | null; created_at: Date; finished_at: Date | null;
};

const toBrief = (r: BriefRow): FbAgentRunBrief => ({
  id: Number(r.id), profile_id: r.profile_id === null ? null : Number(r.profile_id), shadow: r.shadow, state: r.state,
  outcome: r.outcome, decision: r.decision, cost_usd: r.cost_usd === null ? null : Number(r.cost_usd), error: r.error,
  created_at: r.created_at.toISOString(), finished_at: r.finished_at ? r.finished_at.toISOString() : null,
});

const SHADOW_PAGE = 50;

/** Shadow runs newest first, each beside the live run for the same trigger message. */
export async function listShadow(sql: SqlLike, o: { profileId?: number | null; cursor?: number | null }): Promise<FbShadowPage> {
  const rows = await sql<(BriefRow & { thread_id: string | null; trigger_message_id: string | null; trigger_body: string | null; live: BriefRow | null })[]>`
    SELECT s.id, s.profile_id, s.shadow, s.state, s.outcome, s.decision, s.cost_usd, s.error, s.created_at, s.finished_at,
           s.thread_id, s.trigger_message_id, m.body AS trigger_body,
           (SELECT to_jsonb(l) FROM (
              SELECT l.id, l.profile_id, l.shadow, l.state, l.outcome, l.decision, l.cost_usd, l.error, l.created_at, l.finished_at
              FROM fb_agent_runs l
              WHERE l.trigger_message_id = s.trigger_message_id AND l.thread_id = s.thread_id
                AND NOT l.shadow AND l.eval_run_id IS NULL
              ORDER BY l.id DESC LIMIT 1) l) AS live
    FROM fb_agent_runs s LEFT JOIN fb_messages m ON m.id = s.trigger_message_id
    WHERE s.shadow AND s.eval_run_id IS NULL
      AND (${o.profileId ?? null}::bigint IS NULL OR s.profile_id = ${o.profileId ?? null})
      AND (${o.cursor ?? null}::bigint IS NULL OR s.id < ${o.cursor ?? null})
    ORDER BY s.id DESC LIMIT ${SHADOW_PAGE + 1}`;
  const page = rows.slice(0, SHADOW_PAGE);
  return {
    rows: page.map((r) => ({
      trigger_message_id: r.trigger_message_id === null ? null : Number(r.trigger_message_id),
      thread_id: r.thread_id === null ? null : Number(r.thread_id),
      trigger_body: r.trigger_body,
      created_at: r.created_at.toISOString(),
      shadow: toBrief(r),
      // to_jsonb turns the timestamps into strings.
      live: r.live ? toBrief({ ...r.live, created_at: new Date(r.live.created_at), finished_at: r.live.finished_at ? new Date(r.live.finished_at) : null }) : null,
    })),
    next: rows.length > SHADOW_PAGE ? String(page[page.length - 1]!.id) : null,
  };
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

/** Adds the hand-written cases whose names no live case has; returns how many it added. */
export async function seedCases(tx: SqlLike, userId: string | null): Promise<{ added: number }> {
  const have = new Set((await tx<{ name: string }[]>`
    SELECT name FROM fb_agent_eval_cases WHERE archived_at IS NULL`).map((r) => r.name));
  let added = 0;
  for (const c of SEED_CASES) {
    if (have.has(c.name)) continue;
    await createCase(tx, c, userId);
    added++;
  }
  return { added };
}
