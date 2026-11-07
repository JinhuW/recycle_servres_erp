import { describe, it, expect, beforeEach } from 'vitest';
import type { FbAgentProfileRow, RegistryEntry } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { agentRegistry as runtimeRegistry } from '../src/services/fbAgent/registry';
import { agentRegistry as contentRegistry } from '../src/services/fbAgentProfiles';

// Profile versions (CONTRACTS §6.3): only a draft is editable, promotions keep
// one active and one candidate, and params are checked against the registry.

type Refusal = { error: string; detail: string; field?: string };

let cookies: Record<string, string>;
beforeEach(async () => {
  await resetDb();
  cookies = (await loginAs(ALEX)).cookies;
});

const call = <T = FbAgentProfileRow>(method: string, path: string, body?: unknown) =>
  api<T>(method, `/api/fb-agent${path}`, { cookies, body });

async function seeded(): Promise<FbAgentProfileRow> {
  const r = await call<{ rows: FbAgentProfileRow[] }>('GET', '/profiles');
  return r.body.rows.find((p) => p.version === 1)!;
}

async function states(): Promise<Record<number, string>> {
  const rows = await getTestDb()<{ version: number; state: string }[]>`SELECT version, state FROM fb_agent_profiles ORDER BY version`;
  return Object.fromEntries(rows.map((r) => [r.version, r.state]));
}

describe('/api/fb-agent profiles', () => {
  it('is for managers only', async () => {
    const purchaser = await loginAs(MARCUS);
    expect((await api('GET', '/api/fb-agent/profiles', { cookies: purchaser.cookies })).status).toBe(403);
  });

  it('serves the registry with every §6.5 rule and the three skills', async () => {
    const r = await call<{ rules: RegistryEntry[]; skills: RegistryEntry[] }>('GET', '/registry');
    expect(r.body.rules.map((e) => e.kind)).toEqual([
      'closing', 'no_market_match', 'price_stale', 'logistics', 'has_image',
      'unknown_direction', 'confidence_below', 'intent', 'bot_question', 'keyword',
    ]);
    expect(r.body.skills.map((e) => e.kind)).toEqual(['screen', 'negotiate', 'answer']);
    // The modules' own schemas, not a copy that can drift from what runs.
    expect(r.body).toEqual(runtimeRegistry());
    expect(contentRegistry()).toEqual(runtimeRegistry());
  });

  it('makes a draft from any version; only the draft is editable', async () => {
    const v1 = await seeded();
    const patchV1 = await call<Refusal>('PATCH', `/profiles/${v1.id}`, { notes: 'x' });
    expect(patchV1.status).toBe(409);
    expect(patchV1.body.error).toBe('not_draft');

    const d = await call('POST', `/profiles/${v1.id}/draft`);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ name: 'default', version: 2, state: 'draft', based_on: v1.id });
    expect(d.body.rules).toEqual(v1.rules);

    const edited = await call('PATCH', `/profiles/${d.body.id}`, { notes: 'Tighter closing gap', rules: v1.rules.map((r) => r.kind === 'closing' ? { ...r, params: { gap_pct: 5 } } : r) });
    expect(edited.status).toBe(200);
    expect(edited.body.notes).toBe('Tighter closing gap');
    expect(edited.body.rules[0]!.params).toEqual({ gap_pct: 5 });

    // Once promoted it is frozen too.
    expect((await call('POST', `/profiles/${d.body.id}/promote`, { to: 'candidate' })).status).toBe(200);
    expect((await call<Refusal>('PATCH', `/profiles/${d.body.id}`, { notes: 'y' })).status).toBe(409);
    expect((await call<Refusal>('PATCH', `/profiles/${d.body.id}`, { state: 'active' })).status).toBe(409);
  });

  it('refuses params a rule schema rejects, naming the field', async () => {
    const v1 = await seeded();
    const d = (await call('POST', `/profiles/${v1.id}/draft`)).body;
    const withRule = (kind: string, params: unknown) => v1.rules.map((r) => r.kind === kind ? { ...r, params } : r);

    const cases: [unknown, string][] = [
      [withRule('closing', { gap_pct: 'ten' }), 'rules[0].params.gap_pct'],
      [withRule('closing', { gap_pct: 150 }), 'rules[0].params.gap_pct'],
      [withRule('confidence_below', {}), 'rules[6].params.min'],
      [withRule('intent', { kinds: ['hostile', 'rude'] }), 'rules[7].params.kinds'],
      [withRule('has_image', { strict: true }), 'rules[4].params.strict'],
      [[...v1.rules, { kind: 'telepathy', enabled: true, params: {} }], 'rules[10].kind'],
    ];
    for (const [rules, field] of cases) {
      const r = await call<Refusal>('PATCH', `/profiles/${d.id}`, { rules });
      expect(r.status, field).toBe(400);
      expect(r.body.field).toBe(field);
      expect(r.body.detail).toContain(field);
    }
    // A bad draft written behind the API's back still cannot leave draft.
    const db = getTestDb();
    await db`UPDATE fb_agent_profiles SET rules = ${db.json(withRule('closing', { gap_pct: -1 }) as never)} WHERE id = ${d.id}`;
    const p = await call<Refusal>('POST', `/profiles/${d.id}/promote`, { to: 'active' });
    expect(p.status).toBe(400);
    expect(p.body.field).toBe('rules[0].params.gap_pct');
    expect(await states()).toEqual({ 1: 'active', 2: 'draft' });
  });

  it('promote, retire and roll back keep exactly one active', async () => {
    const v1 = await seeded();
    const v2 = (await call('POST', `/profiles/${v1.id}/draft`)).body;
    const v3 = (await call('POST', `/profiles/${v1.id}/draft`)).body;
    expect(v3.version).toBe(3);

    // A new candidate sends the old one back to draft.
    await call('POST', `/profiles/${v2.id}/promote`, { to: 'candidate' });
    expect(await states()).toEqual({ 1: 'active', 2: 'candidate', 3: 'draft' });
    await call('POST', `/profiles/${v3.id}/promote`, { to: 'candidate' });
    expect(await states()).toEqual({ 1: 'active', 2: 'draft', 3: 'candidate' });

    // Candidate to active retires the old active.
    const a = await call('POST', `/profiles/${v3.id}/promote`, { to: 'active' });
    expect(a.body.state).toBe('active');
    expect(a.body.promoted_at).not.toBeNull();
    expect(await states()).toEqual({ 1: 'retired', 2: 'draft', 3: 'active' });

    // The active version cannot be retired on its own.
    const r = await call<Refusal>('POST', `/profiles/${v3.id}/retire`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('is_active');
    expect((await call('POST', `/profiles/${v2.id}/retire`)).body.state).toBe('retired');

    // Rollback: an earlier version becomes active again.
    expect((await call('POST', `/profiles/${v1.id}/promote`, { to: 'active' })).status).toBe(200);
    expect(await states()).toEqual({ 1: 'active', 2: 'retired', 3: 'retired' });

    // Promoting the active version again is refused.
    expect((await call<Refusal>('POST', `/profiles/${v1.id}/promote`, { to: 'active' })).status).toBe(409);
    expect((await call<Refusal>('POST', `/profiles/${v1.id}/promote`, { to: 'boss' })).body.field).toBe('to');
  });

  it('holds one active under concurrent promotes', async () => {
    const v1 = await seeded();
    const drafts = await Promise.all([1, 2, 3].map(async () => (await call('POST', `/profiles/${v1.id}/draft`)).body));
    expect(new Set(drafts.map((d) => d.version))).toEqual(new Set([2, 3, 4]));
    const rs = await Promise.all(drafts.map((d) => call('POST', `/profiles/${d.id}/promote`, { to: 'active' })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const [n] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fb_agent_profiles WHERE state = 'active'`;
    expect(n!.n).toBe(1);
  });

  it('refuses writes on a mirror and unknown ids in words', async () => {
    const v1 = await seeded();
    const m = await api<Refusal>('POST', `/api/fb-agent/profiles/${v1.id}/draft`, { cookies, env: { FLEET_ROLE: 'mirror' } });
    expect(m.status).toBe(409);
    const nf = await call<Refusal>('GET', '/profiles/999999');
    expect(nf.status).toBe(404);
    expect(nf.body.detail).toMatch(/no such/);
  });
});
