import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WechatDay, WechatDayPush, WechatEvidence, WechatHistoryDay, WechatPoint, WechatRow } from '@recycle-erp/shared';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { api } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

const side = (senders: number, median?: number) => ({
  posts: senders, senders, groups: 1, exposures: senders * 2, qty: 0,
  prices: median === undefined ? [] : [{ bucket: 'RMB含税', n: senders, min: median - 100, median, max: median + 100, approx: 0, outliers: 0 }],
});

function dayPush(over: Partial<WechatDayPush> = {}): WechatDayPush {
  return {
    windowStart: '2026-10-20T12:00:00Z',
    windowEnd: '2026-10-21T12:00:00Z',
    degraded: false,
    summary: '- **64G 5600** 需求最旺',
    warnings: [],
    totals: {
      messages: 8000, groupsTotal: 2, groupsActive: 2, candidates: 500, posts: 90,
      buyPosts: 30, sellPosts: 40, buyers: 20, sellers: 25,
    },
    groups: [
      { id: 'g1@chatroom', name: '深圳内存群', messages: 6000, candidates: 400, firstSeen: '2026-08-03T21:43:00Z' },
      { id: 'g2@chatroom', name: '港深30群', messages: 2000, candidates: 100, firstSeen: null },
    ],
    rows: [
      {
        kind: 'quote', key: '三星 64G 5600 DM0', brand: '三星', capacityGb: 64, speed: 5600, code: 'DM0',
        ddr: 'DDR5', formFactor: null, ranks: ['2R4'], partNumbers: ['M321R8GA0BB0-CQK'], signal: '均衡',
        buy: side(3, 14500), sell: side(4, 16000),
      },
      {
        kind: 'spec', key: '64G 5600', brand: null, capacityGb: 64, speed: 5600, code: null,
        ddr: 'DDR5', formFactor: null, ranks: [], partNumbers: [], signal: '偏紧',
        buy: side(10, 14600), sell: side(5),
      },
    ],
    pointCount: 2,
    ...over,
  };
}

function point(over: Partial<WechatPoint> = {}): WechatPoint {
  return {
    postKey: 'wxid_a|abc', itemIndex: 0, senderId: 'wxid_a', senderName: '老王',
    groupIds: ['g2@chatroom', 'g1@chatroom'], firstAt: '2026-10-21T01:00:00Z', lastAt: '2026-10-21T03:00:00Z',
    messages: 5, source: 'llm', direction: 'sell', brands: ['三星'], capacityGb: 64, speed: 5600,
    ddr: 'DDR5', rank: '2R4', formFactor: null, partCodes: ['DM0'], dateCode: null, condition: '全新',
    price: 16000, priceApprox: false, currency: 'RMB', tax: '含税', qty: 100, location: '深圳',
    rawLine: '出 三星 64G 5600 DM0 16000含税', rowKeys: ['spec:64G 5600', 'quote:三星 64G 5600 DM0'],
    ...over,
  };
}

describe('WeChat market (/api/wechat-market)', () => {
  let pushBearer: string;
  let marketBearer: string;

  beforeAll(async () => {
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
  });

  beforeEach(async () => {
    await resetDb();
    const env = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_OAUTH_KEY__,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as never;
    const sql = getTestDb();
    const [{ id: manager }] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const mint = async (scopes: ('wechat:write' | 'market:write')[]) => {
      const client = await createOAuthClient(sql, {
        name: scopes.join(' '), redirectUris: [], grantTypes: ['client_credentials'], scopes,
        createdBy: manager, public: false,
      });
      return signAccessToken(env, { clientId: client.clientId, userId: null, scopes });
    };
    pushBearer = await mint(['wechat:write']);
    marketBearer = await mint(['market:write']);
  });

  const push = (date: string, body: unknown, bearer = pushBearer) =>
    api('PUT', `/api/wechat-market/push/days/${date}`, {
      body, headers: { authorization: `Bearer ${bearer}`, 'X-Requested-By': '' },
    });
  const pushPoints = (date: string, points: unknown[]) =>
    api<{ stored: number }>('POST', `/api/wechat-market/push/days/${date}/points`, {
      body: { points }, headers: { authorization: `Bearer ${pushBearer}`, 'X-Requested-By': '' },
    });

  it('takes a push only with a wechat:write token, and without the CSRF header', async () => {
    expect((await api('PUT', '/api/wechat-market/push/days/2026-10-21', { body: dayPush() })).status).toBe(401);
    expect((await push('2026-10-21', dayPush(), marketBearer)).status).toBe(403);
    const r = await push('2026-10-21', dayPush());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ date: '2026-10-21', rows: 2, groups: 2, pushId: expect.any(String) });
  });

  it('refuses a malformed day, naming the field, and stores nothing', async () => {
    const bad = dayPush();
    (bad.rows[0] as unknown as Record<string, unknown>).buy = { ...side(1), posts: -1 };
    const r = await push('2026-10-21', bad);
    expect(r.status).toBe(400);
    expect((r.body as { detail: string }).detail).toContain('rows[0].buy.posts');
    expect((await push('2026-02-30', dayPush())).status).toBe(400);
    const dup = dayPush({ rows: [dayPush().rows[0]!, dayPush().rows[0]!] });
    expect((await push('2026-10-21', dup)).status).toBe(400);
    // Date.parse reads this; Postgres's timestamptz cast doesn't.
    const local = await push('2026-10-21', dayPush({ windowEnd: '10/21/2026 12:00 PM' }));
    expect(local.status).toBe(400);
    expect((local.body as { detail: string }).detail).toContain('windowEnd');
    const [{ n }] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM wechat_market_days`;
    expect(n).toBe(0);
  });

  it('takes points only for a pushed day, and a retried batch once', async () => {
    expect((await pushPoints('2026-10-21', [point()])).status).toBe(404);
    await push('2026-10-21', dayPush());
    expect((await pushPoints('2026-10-21', [point()])).body.stored).toBe(1);
    const again = await pushPoints('2026-10-21', [point(), point({ itemIndex: 1, direction: 'buy', price: 14500 })]);
    expect(again.body.stored).toBe(2);
    expect((await pushPoints('2026-10-21', [point({ source: 'guess' as never })])).status).toBe(400);
  });

  it('takes a group with no name and a sender with no display name', async () => {
    const day = dayPush();
    day.groups[1]!.name = '';
    expect((await push('2026-10-21', day)).status).toBe(200);
    expect((await pushPoints('2026-10-21', [point({ senderName: '' })])).body.stored).toBe(1);
    const { token } = await loginAs(ALEX);
    const r = await api<{ points: WechatEvidence[] }>(
      'GET', `/api/wechat-market/days/2026-10-21/points?kind=spec&key=${encodeURIComponent('64G 5600')}`, { token },
    );
    expect(r.body.points[0]).toMatchObject({ senderName: '', groups: ['g2@chatroom', '深圳内存群'] });
  });

  it('refuses a batch left over from a push the day has since replaced', async () => {
    const first = await push('2026-10-21', dayPush());
    const stale = (first.body as { pushId: string }).pushId;
    const second = await push('2026-10-21', dayPush());
    const current = (second.body as { pushId: string }).pushId;
    expect(current).not.toBe(stale);

    const batch = (pushId: string) => api<{ stored?: number; error?: string }>(
      'POST', '/api/wechat-market/push/days/2026-10-21/points', {
        body: { points: [point()], pushId }, headers: { authorization: `Bearer ${pushBearer}`, 'X-Requested-By': '' },
      });
    const refused = await batch(stale);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('day_replaced');
    expect((await batch(current)).body.stored).toBe(1);
    const [{ stored_points }] = await getTestDb()<{ stored_points: number }[]>`
      SELECT stored_points FROM wechat_market_days WHERE report_date = '2026-10-21'
    `;
    expect(stored_points).toBe(1);
  });

  it('replaces the whole day on a re-push', async () => {
    await push('2026-10-21', dayPush());
    await pushPoints('2026-10-21', [point()]);
    const redo = dayPush({ degraded: true, rows: [dayPush().rows[1]!], pointCount: 0 });
    expect((await push('2026-10-21', redo)).status).toBe(200);
    const sql = getTestDb();
    const [counts] = await sql<{ rows: number; points: number; degraded: boolean }[]>`
      SELECT (SELECT COUNT(*) FROM wechat_market_rows)::int AS rows,
             (SELECT COUNT(*) FROM wechat_market_points)::int AS points,
             (SELECT degraded FROM wechat_market_days) AS degraded
    `;
    expect(counts).toEqual({ rows: 1, points: 0, degraded: true });
  });

  describe('reads', () => {
    beforeEach(async () => {
      const prev = dayPush({
        windowStart: '2026-10-19T12:00:00Z', windowEnd: '2026-10-20T12:00:00Z',
        rows: [{ ...dayPush().rows[0]!, sell: side(2, 15000) }],
      });
      await push('2026-10-20', prev);
      await push('2026-10-21', dayPush());
      await pushPoints('2026-10-21', [point(), point({ postKey: 'wxid_b|def', senderName: '小李', direction: 'buy', price: 14500, rowKeys: ['spec:64G 5600'] })]);
    });

    it('is for managers only', async () => {
      expect((await api('GET', '/api/wechat-market/days')).status).toBe(401);
      const { token } = await loginAs(MARCUS);
      expect((await api('GET', '/api/wechat-market/days', { token })).status).toBe(403);
    });

    it('lists the days newest first, with how much evidence arrived', async () => {
      const { token } = await loginAs(ALEX);
      const r = await api<{ days: WechatDay[] }>('GET', '/api/wechat-market/days', { token });
      expect(r.body.days.map((d) => [d.date, d.pointCount, d.storedPoints])).toEqual([
        ['2026-10-21', 2, 2],
        ['2026-10-20', 2, 0],
      ]);
      expect(r.body.days[0]!.totals.buyers).toBe(20);
    });

    it('returns one kind of line, each with the day before', async () => {
      const { token } = await loginAs(ALEX);
      const r = await api<{ day: WechatDay; rows: WechatRow[] }>('GET', '/api/wechat-market/days/2026-10-21?kind=quote', { token });
      expect(r.status).toBe(200);
      expect(r.body.day).toMatchObject({ prevDate: '2026-10-20', nextDate: null, summary: '- **64G 5600** 需求最旺' });
      expect(r.body.day.groups.map((g) => g.name)).toEqual(['深圳内存群', '港深30群']);
      expect(r.body.rows).toHaveLength(1);
      const [row] = r.body.rows;
      expect(row).toMatchObject({ key: '三星 64G 5600 DM0', brand: '三星', code: 'DM0', ranks: ['2R4'] });
      expect(row!.sell.prices[0]!.median).toBe(16000);
      expect(row!.prev).toEqual({ buy: expect.objectContaining({ median: 14500 }), sell: expect.objectContaining({ median: 15000 }) });

      const spec = await api<{ rows: WechatRow[] }>('GET', '/api/wechat-market/days/2026-10-21?kind=spec', { token });
      expect(spec.body.rows.map((x) => [x.key, x.prev])).toEqual([['64G 5600', null]]);
      expect((await api('GET', '/api/wechat-market/days/2026-10-22', { token })).status).toBe(404);
      expect((await api('GET', '/api/wechat-market/days/2026-10-21?kind=brand', { token })).status).toBe(400);
    });

    it('finds the posts behind a line, with group names', async () => {
      const { token } = await loginAs(ALEX);
      const q = (qs: string) => api<{ points: WechatEvidence[] }>('GET', `/api/wechat-market/days/2026-10-21/points?${qs}`, { token });
      const all = await q(`kind=spec&key=${encodeURIComponent('64G 5600')}`);
      expect(all.body.points.map((p) => p.senderName).sort()).toEqual(['小李', '老王']);
      const sells = await q(`kind=quote&key=${encodeURIComponent('三星 64G 5600 DM0')}&side=sell`);
      expect(sells.body.points).toHaveLength(1);
      expect(sells.body.points[0]).toMatchObject({ groups: ['港深30群', '深圳内存群'], price: 16000, currency: 'RMB' });
    });

    it('charts a line across report days, zero on a day it was missing', async () => {
      await push('2026-10-22', dayPush({ windowStart: '2026-10-21T12:00:00Z', windowEnd: '2026-10-22T12:00:00Z', rows: [] }));
      const { token } = await loginAs(ALEX);
      const r = await api<{ history: WechatHistoryDay[] }>(
        'GET', `/api/wechat-market/history?kind=quote&key=${encodeURIComponent('三星 64G 5600 DM0')}&until=2026-10-22`, { token },
      );
      expect(r.body.history.map((h) => [h.date, h.sell.senders, h.sell.price?.median ?? null])).toEqual([
        ['2026-10-20', 2, 15000],
        ['2026-10-21', 4, 16000],
        ['2026-10-22', 0, null],
      ]);
    });
  });
});
