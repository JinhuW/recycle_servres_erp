import {
  type FbAgentModule,
  type FbAgentProfile,
  type FbAgentProfileRow,
  type FbAgentProfileState,
  type ParamField,
  type ParamSchema,
  type RegistryEntry,
} from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { agentRegistry as runtimeRegistry } from './fbAgent/registry';

// Agent profile versions (CONTRACTS §6.3). A version's content is frozen once
// it leaves `draft`, so a run's profile_id always names what it ran with. Every
// state change takes one advisory lock: the one-active and one-candidate
// indexes would turn a race between two promotes into a 500 otherwise.

export type AgentRegistry = { rules: RegistryEntry[]; skills: RegistryEntry[] };

// The modules' own schemas (fbAgent/registry.ts): a version is checked
// against the rules and skills this ERP can run, never a copy of them.
export function agentRegistry(): AgentRegistry {
  return runtimeRegistry();
}

/** A refused profile or case write: `detail` says why in words, `field` names the offending input. */
export class FbAgentRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly error: string, readonly detail: string, readonly field?: string) {
    super(detail);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkField(f: ParamField, v: unknown, at: string): string | null {
  switch (f.type) {
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${at} must be a number.`;
      if (f.type === 'integer' && !Number.isInteger(v)) return `${at} must be a whole number.`;
      if (f.minimum !== undefined && v < f.minimum) return `${at} must be at least ${f.minimum}.`;
      if (f.maximum !== undefined && v > f.maximum) return `${at} must be at most ${f.maximum}.`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${at} must be true or false.`;
    case 'string':
      return typeof v === 'string' ? null : `${at} must be text.`;
    case 'array': {
      if (!Array.isArray(v)) return `${at} must be a list.`;
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (typeof item !== 'string') return `${at}[${i}] must be text.`;
        if (f.items.enum && !f.items.enum.includes(item)) return `${at}[${i}] must be one of ${f.items.enum.join(', ')}.`;
      }
      return null;
    }
  }
}

/** The first problem with `params` against `schema`, naming the field; null when valid. */
export function paramsProblem(schema: ParamSchema, params: unknown, at: string): { field: string; detail: string } | null {
  if (!isObj(params)) return { field: at, detail: `${at} must be an object.` };
  for (const key of Object.keys(params)) {
    if (!(key in schema.properties)) return { field: `${at}.${key}`, detail: `${at}.${key} is not a parameter of this module.` };
  }
  for (const key of schema.required ?? []) {
    if (!(key in params)) return { field: `${at}.${key}`, detail: `${at}.${key} is required.` };
  }
  for (const [key, f] of Object.entries(schema.properties)) {
    if (!(key in params)) continue;
    const detail = checkField(f, params[key], `${at}.${key}`);
    if (detail) return { field: `${at}.${key}`, detail };
  }
  return null;
}

type Content = Pick<FbAgentProfile, 'prompts' | 'skills' | 'rules' | 'models' | 'notes'>;

function modulesProblem(list: unknown, entries: RegistryEntry[], at: 'rules' | 'skills'): { field: string; detail: string } | null {
  if (!Array.isArray(list)) return { field: at, detail: `${at} must be a list.` };
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const m = list[i] as unknown;
    const here = `${at}[${i}]`;
    if (!isObj(m) || typeof m.kind !== 'string' || typeof m.enabled !== 'boolean') {
      return { field: here, detail: `${here} needs a kind, enabled and params.` };
    }
    const entry = entries.find((e) => e.kind === m.kind);
    if (!entry) return { field: `${here}.kind`, detail: `${here}.kind: there is no ${at === 'rules' ? 'rule' : 'skill'} called "${m.kind}".` };
    if (seen.has(m.kind)) return { field: `${here}.kind`, detail: `${here}.kind: "${m.kind}" is listed twice.` };
    seen.add(m.kind);
    const p = paramsProblem(entry.params, m.params, `${here}.params`);
    if (p) return p;
  }
  return null;
}

/** The first problem with a version's content, naming the field; null when it may leave draft. */
export function contentProblem(c: Content, reg: AgentRegistry = agentRegistry()): { field: string; detail: string } | null {
  const p = c.prompts as unknown;
  if (!isObj(p) || typeof p.system !== 'string' || typeof p.extract !== 'string' || !isObj(p.skills)
      || !Object.values(p.skills).every((t) => typeof t === 'string')) {
    return { field: 'prompts', detail: 'prompts needs system and extract text and a text per skill.' };
  }
  const m = c.models as unknown;
  if (!isObj(m) || typeof m.extract !== 'string' || !m.extract.trim() || typeof m.reply !== 'string' || !m.reply.trim()) {
    return { field: 'models', detail: 'models needs an extract model and a reply model.' };
  }
  if (typeof c.notes !== 'string') return { field: 'notes', detail: 'notes must be text.' };
  const r = modulesProblem(c.rules, reg.rules, 'rules') ?? modulesProblem(c.skills, reg.skills, 'skills');
  if (r) return r;
  for (const s of c.skills) {
    if (s.enabled && typeof p.skills[s.kind] !== 'string') {
      return { field: `prompts.skills.${s.kind}`, detail: `The ${s.kind} skill is on but has no prompt.` };
    }
  }
  return null;
}

type Row = Omit<FbAgentProfileRow, 'created_at' | 'promoted_at' | 'id' | 'based_on'> & {
  id: string; based_on: string | null; created_at: Date; promoted_at: Date | null;
};

const toRow = (r: Row): FbAgentProfileRow => ({
  id: Number(r.id), name: r.name, version: r.version, state: r.state,
  prompts: r.prompts, skills: r.skills, rules: r.rules, models: r.models, notes: r.notes,
  based_on: r.based_on === null ? null : Number(r.based_on),
  created_by: r.created_by, created_at: r.created_at.toISOString(),
  promoted_at: r.promoted_at ? r.promoted_at.toISOString() : null,
});

const COLS = (sql: SqlLike) => sql`id, name, version, state, prompts, skills, rules, models, notes, based_on, created_by, created_at, promoted_at`;

export async function listProfiles(sql: SqlLike): Promise<FbAgentProfileRow[]> {
  const rows = await sql<Row[]>`SELECT ${COLS(sql)} FROM fb_agent_profiles ORDER BY created_at DESC, id DESC`;
  return rows.map(toRow);
}

export async function getProfile(sql: SqlLike, id: number): Promise<FbAgentProfileRow | null> {
  const [r] = await sql<Row[]>`SELECT ${COLS(sql)} FROM fb_agent_profiles WHERE id = ${id}`;
  return r ? toRow(r) : null;
}

async function lockProfiles(tx: SqlLike): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('fb_agent_profiles'))`;
}

async function mustGet(tx: SqlLike, id: number): Promise<FbAgentProfileRow> {
  const p = await getProfile(tx, id);
  if (!p) throw new FbAgentRefusal(404, 'not_found', 'There is no such profile version.');
  return p;
}

/** A new draft copied from version `fromId`, numbered after the newest version of the same name. */
export async function newDraft(tx: SqlLike, fromId: number, userId: string): Promise<FbAgentProfileRow> {
  await lockProfiles(tx);
  const src = await mustGet(tx, fromId);
  const [r] = await tx<Row[]>`
    INSERT INTO fb_agent_profiles (name, version, state, prompts, skills, rules, models, notes, based_on, created_by)
    SELECT name, (SELECT MAX(version) + 1 FROM fb_agent_profiles WHERE name = ${src.name}), 'draft',
           prompts, skills, rules, models, notes, id, ${userId}
    FROM fb_agent_profiles WHERE id = ${fromId}
    RETURNING ${COLS(tx)}`;
  return toRow(r!);
}

export type ProfilePatch = Partial<Content>;

const PATCHABLE = ['prompts', 'skills', 'rules', 'models', 'notes'] as const;

/** Edits a draft. Anything else is frozen. */
export async function patchDraft(tx: SqlLike, id: number, patch: Record<string, unknown>): Promise<FbAgentProfileRow> {
  await lockProfiles(tx);
  const cur = await mustGet(tx, id);
  if (cur.state !== 'draft') {
    throw new FbAgentRefusal(409, 'not_draft', `Version ${cur.version} is ${cur.state}; only a draft can be edited. Make a new draft from it instead.`);
  }
  for (const k of Object.keys(patch)) {
    if (!(PATCHABLE as readonly string[]).includes(k)) throw new FbAgentRefusal(400, 'invalid', `${k} cannot be edited.`, k);
  }
  const next = { ...cur, ...patch } as Content;
  const problem = contentProblem(next);
  if (problem) throw new FbAgentRefusal(400, 'invalid', problem.detail, problem.field);
  const [r] = await tx<Row[]>`
    UPDATE fb_agent_profiles SET prompts = ${tx.json(next.prompts)}, skills = ${tx.json(next.skills as never)},
      rules = ${tx.json(next.rules as never)}, models = ${tx.json(next.models)}, notes = ${next.notes}
    WHERE id = ${id} RETURNING ${COLS(tx)}`;
  return toRow(r!);
}

const PROMOTABLE: Record<'candidate' | 'active', FbAgentProfileState[]> = {
  // A retired version can come back: that is the rollback.
  candidate: ['draft', 'retired'],
  active: ['draft', 'candidate', 'retired'],
};

/**
 * Makes `id` the candidate or the active version. The active one it replaces
 * is retired; a candidate it replaces goes back to draft (CONTRACTS §6.3).
 */
export async function promote(tx: SqlLike, id: number, to: 'candidate' | 'active'): Promise<FbAgentProfileRow> {
  await lockProfiles(tx);
  const cur = await mustGet(tx, id);
  if (!PROMOTABLE[to].includes(cur.state)) {
    throw new FbAgentRefusal(409, 'bad_state', `Version ${cur.version} is ${cur.state} and cannot become ${to}.`);
  }
  const problem = contentProblem(cur);
  if (problem) throw new FbAgentRefusal(400, 'invalid', problem.detail, problem.field);
  if (to === 'active') {
    await tx`UPDATE fb_agent_profiles SET state = 'retired' WHERE state = 'active' AND id <> ${id}`;
  } else {
    await tx`UPDATE fb_agent_profiles SET state = 'draft' WHERE state = 'candidate' AND id <> ${id}`;
  }
  const [r] = await tx<Row[]>`
    UPDATE fb_agent_profiles SET state = ${to}, promoted_at = NOW() WHERE id = ${id} RETURNING ${COLS(tx)}`;
  return toRow(r!);
}

/** Retires a draft or the candidate. The active version is replaced, never retired on its own. */
export async function retire(tx: SqlLike, id: number): Promise<FbAgentProfileRow> {
  await lockProfiles(tx);
  const cur = await mustGet(tx, id);
  if (cur.state === 'active') {
    throw new FbAgentRefusal(409, 'is_active', 'The active version cannot be retired; promote another version to active instead.');
  }
  if (cur.state === 'retired') return cur;
  const [r] = await tx<Row[]>`UPDATE fb_agent_profiles SET state = 'retired' WHERE id = ${id} RETURNING ${COLS(tx)}`;
  return toRow(r!);
}

export function asProfile(r: FbAgentProfileRow): FbAgentProfile {
  const { id, name, version, state, prompts, skills, rules, models, notes } = r;
  return { id, name, version, state, prompts, skills: skills as FbAgentModule[], rules: rules as FbAgentModule[], models, notes };
}
