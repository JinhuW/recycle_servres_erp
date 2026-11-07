import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FB_SELLER_DEFAULT_SETTINGS, type FbSellerSettings, type FbSettingsChange } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { hoursAround, patchSettings, seedSlot, seedThread } from './helpers/fbSeller';
import { validateFbSellerSettings } from '../src/services/fbConfig';
import { runFbSellerTick } from '../src/services/fbPacing';
import { queueOutbound } from '../src/services/fbThreads';

vi.mock('../src/fleet/seller', async () => ({ enqueueSellerTask: (await import('./helpers/fbSeller')).fakeEnqueueSellerTask }));

beforeEach(async () => { await resetDb(); });

type Refusal = { error: string; detail: string };
const clone = (): FbSellerSettings => structuredClone(FB_SELLER_DEFAULT_SETTINGS);

describe('settings validation', () => {
  it('accepts the seeded defaults', () => {
    expect(validateFbSellerSettings(clone())).toEqual({ ok: true, value: FB_SELLER_DEFAULT_SETTINGS });
  });

  it.each<[string, (s: Record<string, any>) => void, RegExp]>([
    ['a send gap under 10 s', (s) => { s.pacing.send_gap_seconds = 5; }, /^pacing\.send_gap_seconds: must be at least 10$/],
    ['an ad gap under 5 min', (s) => { s.pacing.ad_action_gap_minutes = 4; }, /^pacing\.ad_action_gap_minutes: must be at least 5$/],
    ['an inbox interval under 2 min', (s) => { s.pacing.inbox_every_minutes = 1; }, /^pacing\.inbox_every_minutes: must be at least 2$/],
    ['a fraction', (s) => { s.pacing.sends_per_account_day = 2.5; }, /^pacing\.sends_per_account_day: must be a whole number$/],
    ['a negative', (s) => { s.offer.max_rounds = -1; }, /^offer\.max_rounds: must be at least 0$/],
    ['a percentage of 0', (s) => { s.offer.opening_pct = 0; }, /^offer\.opening_pct: must be a percentage from 1 to 100$/],
    ['a percentage over 100', (s) => { s.offer.step_pct = 101; }, /^offer\.step_pct: must be a percentage/],
    ['a bad time', (s) => { s.active_hours.start = '8:00'; }, /^active_hours\.start: must be a time as HH:MM/],
    ['hour 24', (s) => { s.active_hours.end = '24:00'; }, /^active_hours\.end: must be a time/],
    ['an unknown zone', (s) => { s.active_hours.tz = 'Mars/Olympus'; }, /^active_hours\.tz: "Mars\/Olympus" is not a time zone/],
    ['an unknown key', (s) => { s.pacing.turbo = 1; }, /^pacing\.turbo: is not a setting$/],
    ['a missing key', (s) => { delete s.photos.low_pool_warning; }, /^photos\.low_pool_warning: is missing$/],
    ['a text kill switch', (s) => { s.kill_switch = 'yes'; }, /^kill_switch: must be on or off/],
    ['a bad chat id', (s) => { s.alerts.telegram_chat_id = 'my chat'; }, /^alerts\.telegram_chat_id: must be a numeric chat id/],
  ])('refuses %s, naming the field and saying why', (_name, mutate, detail) => {
    const s = clone() as Record<string, any>;
    mutate(s);
    const v = validateFbSellerSettings(s);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.detail).toMatch(detail);
  });
});

describe('/api/fb-seller/settings', () => {
  it('saves with the version, keeps the history, and refuses a stale version with 409', async () => {
    const m = await loginAs(ALEX);
    const got = await api<{ value: FbSellerSettings; version: number }>('GET', '/api/fb-seller/settings', { cookies: m.cookies });
    expect(got.body).toEqual({ value: FB_SELLER_DEFAULT_SETTINGS, version: 1 });

    const next = clone();
    next.pacing.send_gap_seconds = 90;
    next.alerts.telegram_chat_id = ' -1001234567 ';
    const put = await api<{ value: FbSellerSettings; version: number }>('PUT', '/api/fb-seller/settings', {
      cookies: m.cookies, body: { value: next, version: 1 },
    });
    expect(put.status).toBe(200);
    expect(put.body.version).toBe(2);
    expect(put.body.value.alerts.telegram_chat_id).toBe('-1001234567');

    const stale = await api<Refusal>('PUT', '/api/fb-seller/settings', { cookies: m.cookies, body: { value: next, version: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'stale_settings', detail: 'Someone saved the settings since you opened them.' });

    const bad = await api<Refusal>('PUT', '/api/fb-seller/settings', {
      cookies: m.cookies, body: { value: { ...next, pacing: { ...next.pacing, send_gap_seconds: 3 } }, version: 2 },
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: 'bad_settings', detail: 'pacing.send_gap_seconds: must be at least 10' });

    const hist = await api<{ rows: FbSettingsChange[]; next: string | null }>('GET', '/api/fb-seller/settings/history', { cookies: m.cookies });
    expect(hist.body.rows.map((r) => r.version)).toEqual([2, 1]);
    expect(hist.body.rows[0]!.changed_by_name).toBeTruthy();
    expect(hist.body.rows[0]!.changed_by).not.toBeNull();
    expect(hist.body.rows[0]!.before?.pacing.send_gap_seconds).toBe(60);
    expect(hist.body.rows[0]!.after.pacing.send_gap_seconds).toBe(90);

    const page = await api<{ rows: FbSettingsChange[]; next: string | null }>('GET', '/api/fb-seller/settings/history?limit=1', { cookies: m.cookies });
    expect(page.body.rows.map((r) => r.version)).toEqual([2]);
    const page2 = await api<{ rows: FbSettingsChange[] }>('GET', `/api/fb-seller/settings/history?limit=1&cursor=${page.body.next}`, { cookies: m.cookies });
    expect(page2.body.rows.map((r) => r.version)).toEqual([1]);
  });

  it('is manager-only and refuses a save on a mirror', async () => {
    const p = await loginAs(MARCUS);
    expect((await api('GET', '/api/fb-seller/settings', { cookies: p.cookies })).status).toBe(403);
    const m = await loginAs(ALEX);
    const r = await api<Refusal>('PUT', '/api/fb-seller/settings', {
      cookies: m.cookies, body: { value: clone(), version: 1 }, env: { FLEET_ROLE: 'mirror' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('mirror');
  });
});

describe('the tick reads the settings every pass', () => {
  it('a daily cap changed in the database changes the next pass, with no restart', async () => {
    const db = getTestDb();
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); s.pacing.sends_per_account_day = 0; });
    const acc = await seedSlot();
    const thread = await seedThread(acc);
    const alex = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    await db.begin((tx) => queueOutbound(tx, thread, 'Thanks, what model numbers are they?', { author: 'staff', userId: alex[0]!.id }));

    expect((await runFbSellerTick(getTestDb(), { now })).sends).toBe(0);
    await patchSettings((s) => { s.pacing.sends_per_account_day = 40; });
    expect((await runFbSellerTick(getTestDb(), { now })).sends).toBe(1);
  });

  it('outside active hours it only settles', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 6 * 3600_000);
    await patchSettings((s) => { s.active_hours = hoursAround(later); });
    await seedSlot();
    const r = await runFbSellerTick(getTestDb(), { now });
    expect(r).toMatchObject({ skipped: 'off_hours', inbox: 0 });
    await patchSettings((s) => { s.active_hours = hoursAround(now); });
    expect((await runFbSellerTick(getTestDb(), { now })).inbox).toBe(1);
  });
});
