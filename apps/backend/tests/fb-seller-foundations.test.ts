import { describe, it, expect, beforeEach } from 'vitest';
import { FB_SELLER_DEFAULT_SETTINGS, type FbAgentProfile, type FbSellerSettings } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { loadFbSellerSettings } from '../src/services/fbConfig';

beforeEach(async () => { await resetDb(); });

describe('fb seller seed', () => {
  it('seeds the settings row the TS type describes, and its first history entry', async () => {
    const db = getTestDb();
    const settings = await loadFbSellerSettings(db);
    // FB_SELLER_DEFAULT_SETTINGS is typed FbSellerSettings, so an equal row has
    // exactly the type's keys, nested ones included, with the same value types.
    expect(settings).toStrictEqual(FB_SELLER_DEFAULT_SETTINGS);
    const [h] = await db<{ version: number; before: unknown; after: FbSellerSettings }[]>`
      SELECT version, before, after FROM fb_seller_settings_history`;
    expect(h).toMatchObject({ version: 1, before: null, after: FB_SELLER_DEFAULT_SETTINGS });
    await expect(db`UPDATE fb_seller_settings_history SET version = 2`).rejects.toThrow(/append-only/);
  });

  it('seeds default v1 as the one active profile, with every skill and rule enabled', async () => {
    const db = getTestDb();
    const rows = await db<(FbAgentProfile & { promoted_at: Date | null })[]>`
      SELECT id, name, version, state, prompts, skills, rules, models, notes, promoted_at
      FROM fb_agent_profiles`;
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p).toMatchObject({ name: 'default', version: 1, state: 'active' });
    expect(p.promoted_at).not.toBeNull();
    expect(p.skills.map((s) => s.kind)).toEqual(['screen', 'negotiate', 'answer']);
    expect(p.rules.map((r) => r.kind)).toEqual([
      'closing', 'no_market_match', 'price_stale', 'logistics', 'has_image',
      'unknown_direction', 'confidence_below', 'intent', 'bot_question', 'keyword',
    ]);
    expect([...p.skills, ...p.rules].every((m) => m.enabled)).toBe(true);
    expect(p.rules.find((r) => r.kind === 'closing')?.params).toEqual({ gap_pct: 10 });
    expect(p.rules.find((r) => r.kind === 'confidence_below')?.params).toEqual({ min: 0.6 });
    expect(p.rules.find((r) => r.kind === 'intent')?.params).toEqual({ kinds: ['hostile', 'off_topic'] });
    expect(p.models).toEqual({ extract: 'openai/gpt-6-luna', reply: 'openai/gpt-6-luna' });
    expect(Object.keys(p.prompts.skills).sort()).toEqual(['answer', 'negotiate', 'screen']);
    // The model never names an amount: {{offer}} is the only way one appears.
    const text = [p.prompts.system, p.prompts.extract, ...Object.values(p.prompts.skills)].join('\n');
    expect(text).toContain('{{offer}}');
    expect(text).not.toMatch(/\$\s*\d/);
    // A second active version is refused by the index.
    await expect(db`
      INSERT INTO fb_agent_profiles (name, version, state, prompts, skills, rules, models)
      VALUES ('default', 2, 'active', '{}', '[]', '[]', '{}')`).rejects.toThrow(/fb_agent_profiles_one_active/);
  });
});

describe('fleet_tasks shapes', () => {
  async function cityAndItem() {
    const db = getTestDb();
    await db`INSERT INTO fleet_cities (slug, name) VALUES ('denver', 'Denver') ON CONFLICT DO NOTHING`;
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["server ram"]') ON CONFLICT DO NOTHING`;
  }

  it('keeps search tasks on a city and item', async () => {
    const db = getTestDb();
    await cityAndItem();
    await db`INSERT INTO fleet_tasks (city, item, kind, due_at, state) VALUES ('denver', 'server_ram', 'search', NOW(), 'ready')`;
    await expect(db`INSERT INTO fleet_tasks (kind, due_at, state, account_no, payload)
      VALUES ('search', NOW(), 'ready', 7, '{"ref":"x"}')`).rejects.toThrow(/fleet_tasks_seller_shape/);
  });

  it('takes a seller task with an account and a ref, one open per account, kind and ref', async () => {
    const db = getTestDb();
    await cityAndItem();
    const insert = (ref: string, state = 'ready') => db`INSERT INTO fleet_tasks (kind, due_at, state, account_no, payload)
      VALUES ('msg-send', NOW(), ${state}, 7, ${db.json({ ref })})`;
    await insert('m1');
    await expect(insert('m1')).rejects.toThrow(/fleet_tasks_seller_open_idx/);
    await insert('m2');
    await insert('m1', 'uncertain');
    await expect(db`INSERT INTO fleet_tasks (kind, due_at, state, account_no)
      VALUES ('inbox-sync', NOW(), 'ready', 7)`).rejects.toThrow(/fleet_tasks_seller_shape/);
    await expect(db`INSERT INTO fleet_tasks (city, item, kind, due_at, state, account_no, payload)
      VALUES ('denver', 'server_ram', 'ad-post', NOW(), 'ready', 7, '{"ref":"p1"}')`).rejects.toThrow(/fleet_tasks_seller_shape/);
  });

  it('starts every slot as a search slot with the agent off', async () => {
    const db = getTestDb();
    const cols = await db<{ column_name: string; column_default: string }[]>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'fleet_slots' AND column_name IN ('role', 'agent_on')
      ORDER BY column_name`;
    expect(cols.map((c) => [c.column_name, c.column_default])).toEqual([
      ['agent_on', 'false'], ['role', "'search'::text"],
    ]);
  });
});

describe('/api/fb-seller and /api/fb-agent', () => {
  it('are for managers only', async () => {
    const manager = await loginAs(ALEX);
    const purchaser = await loginAs(MARCUS);
    for (const prefix of ['/api/fb-seller', '/api/fb-agent']) {
      expect((await api('GET', `${prefix}/summary`)).status).toBe(401);
      expect((await api('GET', `${prefix}/summary`, { cookies: purchaser.cookies })).status).toBe(403);
      // No routes yet: a manager passes the gate and finds nothing.
      expect((await api('GET', `${prefix}/summary`, { cookies: manager.cookies })).status).toBe(404);
    }
  });

  it('refuse a write on a mirror ERP with the reason in words', async () => {
    const manager = await loginAs(ALEX);
    const r = await api<{ error: string; detail: string }>('POST', '/api/fb-seller/pools', {
      cookies: manager.cookies, body: { name: 'x' }, env: { FLEET_ROLE: 'mirror' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('mirror');
    expect(r.body.detail).toMatch(/mirrors the fleet/);
  });
});
