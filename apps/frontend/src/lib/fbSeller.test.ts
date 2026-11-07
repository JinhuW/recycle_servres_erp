import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FB_SELLER_DEFAULT_SETTINGS, type FbSellerSettings, type ParamSchema } from '@recycle-erp/shared';

const calls: { method: string; path: string; body?: unknown }[] = [];
vi.mock('./api', () => {
  const rec = (method: string) => (path: string, body?: unknown) => { calls.push({ method, path, body }); return Promise.resolve({}); };
  return { api: { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE'), upload: rec('UPLOAD') } };
});
vi.mock('./errorToast', () => ({ handleFetchError: vi.fn() }));

const {
  fbAgentApi, fbSellerApi, offerLadder, paramProblems, qs, settingsDiff, setSettingsField, sortNeedsHuman, threadStranded, validateFbSettings,
} = await import('./fbSeller');

const settings = (patch: (v: FbSellerSettings) => void = () => {}) => {
  const v = structuredClone(FB_SELLER_DEFAULT_SETTINGS);
  patch(v);
  return v;
};

describe('fbSellerApi', () => {
  beforeEach(() => { calls.length = 0; });

  it('reads and writes the CONTRACTS §5.1 paths', async () => {
    await fbSellerApi.threads('needs_human', { account_no: 12, q: 'r740' });
    await fbSellerApi.threads('inbox');
    await fbSellerApi.reply(4, 'Hello');
    await fbSellerApi.close(4, 'won', 'Picked up');
    await fbSellerApi.saveSettings(FB_SELLER_DEFAULT_SETTINGS, 3);
    await fbSellerApi.place(1, [12, 17], ['Denver, CO']);
    await fbSellerApi.resolve(9, true, '9001');
    await fbSellerApi.resolve(9, false);
    await fbSellerApi.photos(2, 'unused', 'c1');
    await fbSellerApi.patchAccount(12, { role: 'seller' });
    expect(calls).toEqual([
      { method: 'GET', path: '/api/fb-seller/threads?view=needs_human&account_no=12&q=r740', body: undefined },
      { method: 'GET', path: '/api/fb-seller/threads?view=inbox', body: undefined },
      { method: 'POST', path: '/api/fb-seller/threads/4/reply', body: { body: 'Hello' } },
      { method: 'POST', path: '/api/fb-seller/threads/4/close', body: { outcome: 'won', note: 'Picked up' } },
      { method: 'PUT', path: '/api/fb-seller/settings', body: { value: FB_SELLER_DEFAULT_SETTINGS, version: 3 } },
      { method: 'POST', path: '/api/fb-seller/ads/1/place', body: { account_nos: [12, 17], locations: ['Denver, CO'] } },
      { method: 'POST', path: '/api/fb-seller/placements/9/resolve', body: { live: true, fb_listing_id: '9001' } },
      { method: 'POST', path: '/api/fb-seller/placements/9/resolve', body: { live: false } },
      { method: 'GET', path: '/api/fb-seller/pools/2/photos?used=unused&cursor=c1', body: undefined },
      { method: 'PATCH', path: '/api/fb-seller/accounts/12', body: { role: 'seller' } },
    ]);
  });

  it('uploads every file under the field name `file`', async () => {
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    await fbSellerApi.uploadPhotos(3, [a, b]);
    expect(calls[0].method).toBe('UPLOAD');
    expect(calls[0].path).toBe('/api/fb-seller/pools/3/photos');
    expect((calls[0].body as FormData).getAll('file').map(f => (f as File).name)).toEqual(['a.jpg', 'b.png']);
  });

  it('reads and writes the CONTRACTS §6.7 paths', async () => {
    await fbAgentApi.promote(5, 'candidate');
    await fbAgentApi.draft(5);
    await fbAgentApi.shadow(null);
    await fbAgentApi.shadow(2, 'next');
    await fbAgentApi.compare(1, 2);
    await fbAgentApi.evals(3);
    await fbAgentApi.archiveCase(8);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /api/fb-agent/profiles/5/promote',
      'POST /api/fb-agent/profiles/5/draft',
      'GET /api/fb-agent/shadow',
      'GET /api/fb-agent/shadow?profile_id=2&cursor=next',
      'GET /api/fb-agent/evals/compare?a=1&b=2',
      'GET /api/fb-agent/evals?profile_id=3',
      'DELETE /api/fb-agent/cases/8',
    ]);
    expect(calls[0].body).toEqual({ to: 'candidate' });
  });

  it('leaves unset query values out', () => {
    expect(qs({ a: undefined, b: null, c: '', d: 0, e: false })).toBe('?d=0&e=false');
    expect(qs({})).toBe('');
  });
});

describe('validateFbSettings', () => {
  it('accepts the seeded defaults', () => {
    expect(validateFbSettings(FB_SELLER_DEFAULT_SETTINGS)).toEqual([]);
  });

  it('names each field the backend would refuse', () => {
    const v = settings(x => {
      x.pacing.send_gap_seconds = 9;
      x.pacing.ad_action_gap_minutes = 4;
      x.pacing.inbox_every_minutes = 1;
      x.pacing.max_live_ads_per_account = -1;
      x.pacing.renew_days = 2.5;
      x.offer.opening_pct = 0;
      x.offer.step_pct = 101;
      x.agent.daily_spend_usd = Number.NaN;
      x.active_hours.start = '8:00';
      x.active_hours.tz = 'Mars/Olympus';
    });
    const got = Object.fromEntries(validateFbSettings(v).map(p => [p.path, p.key]));
    expect(got).toEqual({
      'pacing.send_gap_seconds': 'fbs_err_min',
      'pacing.ad_action_gap_minutes': 'fbs_err_min',
      'pacing.inbox_every_minutes': 'fbs_err_min',
      'pacing.max_live_ads_per_account': 'fbs_err_min',
      'pacing.renew_days': 'fbs_err_whole',
      'offer.opening_pct': 'fbs_err_pct',
      'offer.step_pct': 'fbs_err_pct',
      'agent.daily_spend_usd': 'fbs_err_whole',
      'active_hours.start': 'fbs_err_hhmm',
      'active_hours.tz': 'fbs_err_tz',
    });
    expect(validateFbSettings(v).find(p => p.path === 'pacing.send_gap_seconds')?.vars).toEqual({ min: 10 });
  });

  it('accepts the bounds themselves', () => {
    const v = settings(x => {
      x.pacing.send_gap_seconds = 10;
      x.pacing.ad_action_gap_minutes = 5;
      x.pacing.inbox_every_minutes = 2;
      x.offer.opening_pct = 1;
      x.offer.step_pct = 100;
      x.photos.low_pool_warning = 0;
    });
    expect(validateFbSettings(v)).toEqual([]);
  });
});

describe('settings helpers', () => {
  it('replaces one field and leaves the rest', () => {
    const v = setSettingsField(FB_SELLER_DEFAULT_SETTINGS, 'pacing.renew_days', 9);
    expect(v.pacing.renew_days).toBe(9);
    expect(v.pacing.send_gap_seconds).toBe(FB_SELLER_DEFAULT_SETTINGS.pacing.send_gap_seconds);
    expect(FB_SELLER_DEFAULT_SETTINGS.pacing.renew_days).toBe(7);
    expect(setSettingsField(v, 'kill_switch', true).kill_switch).toBe(true);
  });

  it('diffs two values by dotted path', () => {
    const after = settings(x => { x.kill_switch = true; x.offer.max_rounds = 4; x.alerts.telegram_chat_id = '-100'; });
    expect(settingsDiff(FB_SELLER_DEFAULT_SETTINGS, after)).toEqual([
      { path: 'kill_switch', from: false, to: true },
      { path: 'offer.max_rounds', from: 3, to: 4 },
      { path: 'alerts.telegram_chat_id', from: null, to: '-100' },
    ]);
    expect(settingsDiff(null, after).length).toBeGreaterThan(20);
  });
});

describe('sortNeedsHuman', () => {
  it('puts closing deals first, then the longest wait', () => {
    const rows = [
      { id: 1, stage: 'negotiating' as const, human_at: '2026-11-07T10:00:00Z' },
      { id: 2, stage: 'closing' as const, human_at: '2026-11-07T11:00:00Z' },
      { id: 3, stage: 'screening' as const, human_at: '2026-11-07T09:00:00Z' },
      { id: 4, stage: 'closing' as const, human_at: '2026-11-07T08:00:00Z' },
      { id: 5, stage: 'new' as const, human_at: null },
    ];
    expect(sortNeedsHuman(rows).map(r => r.id)).toEqual([4, 2, 3, 1, 5]);
  });
});

describe('offerLadder', () => {
  it('climbs by the step, never past the ceiling, to the dollar', () => {
    expect(offerLadder(960, FB_SELLER_DEFAULT_SETTINGS.offer)).toEqual([672, 768, 864]);
    expect(offerLadder(100, { ...FB_SELLER_DEFAULT_SETTINGS.offer, opening_pct: 90, step_pct: 20 })).toEqual([90, 100, 100]);
    expect(offerLadder(333, { ...FB_SELLER_DEFAULT_SETTINGS.offer, max_rounds: 0 })).toEqual([233]);
  });
});

describe('threadStranded', () => {
  const accounts = [
    { account_no: 1, role: 'seller' as const, account_state: 'HEALTHY' },
    { account_no: 2, role: 'search' as const, account_state: 'HEALTHY' },
    { account_no: 3, role: 'seller' as const, account_state: 'RETIRED' },
  ].map(a => ({ ...a, agent_on: true, agent_profile_id: null, worker_id: null, live_ads: 0, open_threads: 0, needs_human: 0, sends_today: 0 }));
  it('marks a thread whose account is gone, retired or not a seller', () => {
    expect(threadStranded(1, accounts)).toBe(false);
    expect(threadStranded(2, accounts)).toBe(true);
    expect(threadStranded(3, accounts)).toBe(true);
    expect(threadStranded(9, accounts)).toBe(true);
    expect(threadStranded(null, accounts)).toBe(true);
    expect(threadStranded(9, null)).toBe(false);
  });
});

describe('paramProblems', () => {
  const schema: ParamSchema = {
    type: 'object',
    properties: {
      gap_pct: { type: 'integer', label: 'Gap', minimum: 0, maximum: 100 },
      min: { type: 'number', label: 'Min', minimum: 0, maximum: 1 },
      kinds: { type: 'array', label: 'Kinds', items: { type: 'string', enum: ['hostile', 'off_topic'] } },
      on: { type: 'boolean', label: 'On' },
    },
    required: ['gap_pct'],
  };
  it('passes params that fit the schema', () => {
    expect(paramProblems({ gap_pct: 10, min: 0.6, kinds: ['hostile'], on: true }, schema)).toEqual([]);
    expect(paramProblems({ anything: 1 }, null)).toEqual([]);
  });
  it('names each param that does not', () => {
    expect(paramProblems({ min: 1.5, kinds: ['rude'], on: 'yes' }, schema)).toEqual(['gap_pct', 'min', 'kinds', 'on']);
    expect(paramProblems({ gap_pct: 2.5 }, schema)).toEqual(['gap_pct']);
  });
});
