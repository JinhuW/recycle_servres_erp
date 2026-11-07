import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getDb } from '../db';
import { isMirror, managerSession, type ManagerEnv } from '../fleet/auth';
import { log } from '../lib/log';
import { agentLlmFor, agentSpentTodayUsd, decide } from '../services/fbAgent';
import {
  archiveCase, compareEvals, createCase, createEvalRun, evalDetail, listCases, listEvalRuns, listShadow,
  patchCase, readExpectation, readInput, runEval, seedCases,
} from '../services/fbAgentEval';
import { FbAgentRefusal, agentRegistry, getProfile, listProfiles, newDraft, patchDraft, promote, retire } from '../services/fbAgentProfiles';

// ─── /api/fb-agent ───────────────────────────────────────────────────────────────
// Manager-only: agent profile versions, shadow runs, replay cases and eval
// runs (CONTRACTS §6.7).

const fbAgent = new Hono<ManagerEnv>();

fbAgent.use('*', managerSession);

// A mirror ERP holds a copy of the fleet's database; a write here would land on
// the copy and be lost at the next sync.
const refuseMirrorWrites: MiddlewareHandler<ManagerEnv> = async (c, next) => {
  if (isMirror(c.env) && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'mirror', detail: 'This ERP mirrors the fleet; make the change on the ERP that runs it.' }, 409);
  }
  return next();
};
fbAgent.use('*', refuseMirrorWrites);

fbAgent.onError((e, c) => {
  if (e instanceof FbAgentRefusal) {
    return c.json({ error: e.error, detail: e.detail, ...(e.field ? { field: e.field } : {}) }, e.status);
  }
  throw e;
});

function idParam(c: Context<ManagerEnv>, name = 'id'): number {
  const raw = c.req.param(name) ?? '';
  const n = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  if (n <= 0) throw new FbAgentRefusal(404, 'not_found', 'There is no such record.');
  return n;
}

const idQuery = (raw: string | undefined) => (raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null);

async function body(c: Context<ManagerEnv>): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new FbAgentRefusal(400, 'invalid', 'The request needs a JSON object.');
  return b as Record<string, unknown>;
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

fbAgent.get('/registry', (c) => c.json(agentRegistry()));

fbAgent.get('/profiles', async (c) => c.json({ rows: await listProfiles(getDb(c.env)) }));

fbAgent.get('/profiles/:id', async (c) => {
  const p = await getProfile(getDb(c.env), idParam(c));
  if (!p) throw new FbAgentRefusal(404, 'not_found', 'There is no such profile version.');
  return c.json(p);
});

fbAgent.post('/profiles/:id/draft', async (c) => {
  const id = idParam(c);
  const p = await getDb(c.env).begin((tx) => newDraft(tx, id, c.var.user.id));
  return c.json(p, 201);
});

fbAgent.patch('/profiles/:id', async (c) => {
  const id = idParam(c);
  const patch = await body(c);
  return c.json(await getDb(c.env).begin((tx) => patchDraft(tx, id, patch)));
});

fbAgent.post('/profiles/:id/promote', async (c) => {
  const id = idParam(c);
  const { to } = await body(c);
  if (to !== 'candidate' && to !== 'active') throw new FbAgentRefusal(400, 'invalid', 'to must be candidate or active.', 'to');
  return c.json(await getDb(c.env).begin((tx) => promote(tx, id, to)));
});

fbAgent.post('/profiles/:id/retire', async (c) => {
  const id = idParam(c);
  return c.json(await getDb(c.env).begin((tx) => retire(tx, id)));
});

// ─── Shadow ───────────────────────────────────────────────────────────────────

fbAgent.get('/shadow', async (c) => {
  return c.json(await listShadow(getDb(c.env), { profileId: idQuery(c.req.query('profile_id')), cursor: idQuery(c.req.query('cursor')) }));
});

// ─── Cases ────────────────────────────────────────────────────────────────────

function caseName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new FbAgentRefusal(400, 'invalid', 'A case needs a name of up to 200 characters.', 'name');
  return v.trim();
}

fbAgent.get('/cases', async (c) => c.json({ rows: await listCases(getDb(c.env), c.req.query('archived') === '1') }));

fbAgent.post('/cases', async (c) => {
  const b = await body(c);
  const input = { name: caseName(b.name), input: readInput(b.input), expected: readExpectation(b.expected) };
  return c.json(await getDb(c.env).begin((tx) => createCase(tx, input, c.var.user.id)), 201);
});

fbAgent.post('/cases/seed', async (c) => c.json(await getDb(c.env).begin((tx) => seedCases(tx, c.var.user.id))));

fbAgent.patch('/cases/:id', async (c) => {
  const id = idParam(c);
  const b = await body(c);
  const patch = {
    ...(b.name !== undefined ? { name: caseName(b.name) } : {}),
    ...(b.input !== undefined ? { input: readInput(b.input) } : {}),
    ...(b.expected !== undefined ? { expected: readExpectation(b.expected) } : {}),
  };
  return c.json(await getDb(c.env).begin((tx) => patchCase(tx, id, patch)));
});

fbAgent.delete('/cases/:id', async (c) => {
  const id = idParam(c);
  await getDb(c.env).begin((tx) => archiveCase(tx, id));
  return c.json({ ok: true });
});

// ─── Evals ────────────────────────────────────────────────────────────────────

fbAgent.get('/evals', async (c) => c.json({ rows: await listEvalRuns(getDb(c.env), idQuery(c.req.query('profile_id'))) }));

fbAgent.post('/evals', async (c) => {
  const { profile_id } = await body(c);
  if (typeof profile_id !== 'number' || !Number.isInteger(profile_id) || profile_id <= 0) {
    throw new FbAgentRefusal(400, 'invalid', 'profile_id must name a profile version.', 'profile_id');
  }
  const sql = getDb(c.env);
  const ev = await sql.begin((tx) => createEvalRun(tx, profile_id, c.var.user.id));
  // Real model calls take minutes over a full case list; the page polls GET /evals/:id.
  void runEval(sql, ev.id, { llm: agentLlmFor(c.env), decide, spentToday: agentSpentTodayUsd })
    .catch((e: unknown) => log.error('fb agent eval run crashed', { evalRunId: ev.id, error: e instanceof Error ? e.message : String(e) }));
  return c.json(ev, 202);
});

fbAgent.get('/evals/compare', async (c) => {
  const a = idQuery(c.req.query('a'));
  const b = idQuery(c.req.query('b'));
  if (!a || !b) throw new FbAgentRefusal(400, 'invalid', 'Compare needs two eval runs, a and b.', !a ? 'a' : 'b');
  return c.json(await compareEvals(getDb(c.env), a, b));
});

fbAgent.get('/evals/:id', async (c) => c.json(await evalDetail(getDb(c.env), idParam(c))));

export default fbAgent;
