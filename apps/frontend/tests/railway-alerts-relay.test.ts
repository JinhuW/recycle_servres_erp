import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — plain JS Worker module, no types.
import worker, { alertMessage, format } from '../../../deploy/railway-alerts/worker.js';

// RS-368: Railway's raw webhook JSON relayed into one Telegram topic per kind
// of alert.

const env = {
  WEBHOOK_SECRET: 's3cret',
  ALERT_TOKEN: 'alert-token',
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_CHAT_ID: '-1001',
  TOPICS: { deploy_failed: 11, crashed: 12, monitor: 13, volume: 14, reddit_workers: 16 },
};

const resource = {
  workspace: { id: 'w', name: 'My Projects' },
  project: { id: 'p1', name: 'recycle-erp-experiment' },
  environment: { id: 'e1', name: 'production', isEphemeral: false },
  service: { id: 's1', name: 'backend' },
  deployment: { id: 'd1' },
};

const event = (type: string, details: Record<string, unknown> = {}) => ({
  type,
  details,
  resource,
  severity: 'WARNING',
  timestamp: '2026-10-23T12:00:00.000Z',
});

const post = (body: unknown, auth: string | null = 'Bearer s3cret') =>
  worker.fetch(
    new Request('https://railway-alerts.example/', {
      method: 'POST',
      headers: auth ? { Authorization: auth } : {},
      body: JSON.stringify(body),
    }),
    env,
  ) as Promise<Response>;

const postAlert = (body: unknown, auth: string | null = 'Bearer alert-token') =>
  worker.fetch(
    new Request('https://railway-alerts.example/alert', {
      method: 'POST',
      headers: auth ? { Authorization: auth } : {},
      body: JSON.stringify(body),
    }),
    env,
  ) as Promise<Response>;

type Sent = { chat_id: string; message_thread_id?: number; text: string; parse_mode: string };
let sent: Sent[];
let answer: (call: number) => { status: number; body: unknown };

beforeEach(() => {
  sent = [];
  answer = () => ({ status: 200, body: { ok: true, result: { message_id: 1 } } });
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const { status, body } = answer(sent.length);
    return new Response(JSON.stringify(body), { status });
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Railway alert relay', () => {
  it.each([
    [null],
    ['Bearer wrong'],
    ['s3cret'],
  ])('refuses Authorization %s and sends nothing', async (auth) => {
    const res = await post(event('Deployment.failed'), auth);
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it('refuses everything when no secret is configured', async () => {
    const res = (await worker.fetch(
      new Request('https://railway-alerts.example/', {
        method: 'POST',
        headers: { Authorization: 'Bearer undefined' },
        body: JSON.stringify(event('Deployment.failed')),
      }),
      { ...env, WEBHOOK_SECRET: undefined },
    )) as Response;
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it.each([
    ['Deployment.failed', 11],
    ['Deployment.crashed', 12],
    ['Deployment.oom_killed', 12],
    ['Monitor.triggered', 13],
    ['Monitor.resolved', 13],
    ['VolumeAlert.triggered', 14],
    ['VolumeAlert.resolved', 14],
  ])('puts %s in topic %i', async (type, thread) => {
    const res = await post(event(type));
    expect(res.status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: '-1001', message_thread_id: thread, parse_mode: 'HTML' });
  });

  it('sends an event it has no topic for to General', async () => {
    await post(event('Deployment.deployed'));
    expect(sent[0].message_thread_id).toBeUndefined();
  });

  it('falls back to General when the topic was deleted', async () => {
    answer = (call) => call === 1
      ? { status: 400, body: { ok: false, description: 'Bad Request: message thread not found' } }
      : { status: 200, body: { ok: true } };
    const res = await post(event('Deployment.crashed'));
    expect(res.status).toBe(204);
    expect(sent.map((m) => m.message_thread_id)).toEqual([12, undefined]);
  });

  it('answers 502 when Telegram rejects the send, so Railway retries', async () => {
    answer = () => ({ status: 403, body: { ok: false, description: 'Forbidden: bot was kicked' } });
    const res = await post(event('Deployment.failed'));
    expect(res.status).toBe(502);
    expect(sent).toHaveLength(1);
  });

  it('answers 404 to anything but POST /', async () => {
    const res = (await worker.fetch(new Request('https://railway-alerts.example/'), env)) as Response;
    expect(res.status).toBe(404);
  });
});

describe('format', () => {
  it('names where it happened, the commit, and links to the deployment', () => {
    const text = format(event('Deployment.crashed', {
      id: 'd1',
      source: 'GitHub',
      status: 'CRASHED',
      branch: 'main',
      commitHash: '9f3b6cfa1234567',
      commitAuthor: 'jinhu',
      commitMessage: 'fix(orders): manager-only\n\nlong body',
    }));
    expect(text).toBe([
      '<b>🔴 Crashed</b>',
      'recycle-erp-experiment / production / backend',
      '<code>9f3b6cf</code> fix(orders): manager-only — jinhu',
      '<a href="https://railway.com/project/p1/service/s1?id=d1&amp;environmentId=e1">Open in Railway</a>',
    ].join('\n'));
  });

  it('escapes payload text for HTML mode', () => {
    const text = format(event('Deployment.failed', {
      commitHash: 'abc1234',
      commitMessage: 'a <b> & "c"',
    }));
    expect(text).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(text).not.toContain('<b> &');
  });

  it('lists the details of a monitor or volume alert', () => {
    const text = format({
      type: 'VolumeAlert.triggered',
      details: { usedPercent: 91, alert: { threshold: 90, note: null } },
      resource: { project: resource.project, environment: resource.environment, volume: { id: 'v1', name: 'pg-data' } },
    });
    expect(text).toBe([
      '<b>⚠️ Volume alert</b>',
      'recycle-erp-experiment / production / pg-data',
      'usedPercent: 91',
      'alert.threshold: 90',
      '<a href="https://railway.com/project/p1?environmentId=e1">Open in Railway</a>',
    ].join('\n'));
  });
});

// RS-375: our own senders post `{topic, status, title, lines, link}` to /alert.
describe('/alert', () => {
  const alert = { topic: 'reddit_workers', status: 'firing', title: 'Reddit worker down', lines: ['c814 · last beat 12m ago'] };

  it.each([
    [null],
    ['Bearer s3cret'],
    ['Bearer wrong'],
  ])('refuses Authorization %s and sends nothing', async (auth) => {
    const res = await postAlert(alert, auth);
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it('does not take the alert bearer on the Railway route', async () => {
    const res = await post(event('Deployment.failed'), 'Bearer alert-token');
    expect(res.status).toBe(401);
  });

  it('puts the alert in its topic', async () => {
    const res = await postAlert(alert);
    expect(res.status).toBe(204);
    expect(sent[0]).toMatchObject({ chat_id: '-1001', message_thread_id: 16, parse_mode: 'HTML' });
    expect(sent[0].text).toBe('<b>🔴 Reddit worker down</b>\nc814 · last beat 12m ago');
  });

  it.each([['nope'], ['constructor'], [undefined]])('sends topic %s to General', async (topic) => {
    await postAlert({ ...alert, topic });
    expect(sent[0].message_thread_id).toBeUndefined();
  });

  it('answers 502 when Telegram rejects it, so the sender retries', async () => {
    answer = () => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } });
    const res = await postAlert(alert);
    expect(res.status).toBe(502);
  });

  it('renders status, escapes text and keeps the link', () => {
    const { text, topic } = alertMessage({
      topic: 'erp_uptime',
      status: 'resolved',
      title: 'prod <ok>',
      lines: ['a & b'],
      link: 'https://x.example/?a=1&b=2',
    });
    expect(topic).toBe('erp_uptime');
    expect(text).toBe([
      '<b>✅ prod &lt;ok&gt;</b>',
      'a &amp; b',
      '<a href="https://x.example/?a=1&amp;b=2">Open</a>',
    ].join('\n'));
  });

  it('stays under Telegram\'s length cap however many lines come', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i} ${'x'.repeat(280)}`);
    const { text } = alertMessage({ topic: 'reddit_errors', status: 'info', title: 'errors', lines });
    expect(text.length).toBeLessThan(4096);
    expect(text).toMatch(/… \d+ more$/);
  });
});
