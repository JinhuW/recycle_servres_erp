import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TelegramCall } from '../src/lib/telegramBot';
import { formatWebLead } from '../src/lib/webLeadAlert';
import { TelegramError } from '../src/lib/telegramBot';
import { fbChatTelegramConfig, resetLeadRetryForTests, runFbChatTelegramTick, setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { getTestDb, resetDb } from './helpers/db';

// A website submission queues a Telegram alert on the chat hub, which posts it
// to the group's General topic.

const CHAT = '-1009876543';
let ipSeq = 0;
const post = <T>(path: string, body: unknown) =>
  api<T>('POST', `/api/public/${path}`, {
    body, headers: { 'X-Forwarded-For': `198.51.100.${++ipSeq}`, 'X-Requested-By': '' },
  });

const ramLine = {
  category: 'RAM', qty: 24,
  fields: { capacity: '32GB', speed: '2933', brand: 'Samsung', part_number: 'M393A4K40CB2-CVF' },
};
const quote = {
  customer_type: 'business', hardware: ['Servers', 'Networking'], quantity: '11-50',
  name: 'Dana Ops', company: 'Acme DC', email: 'dana@acme.example', phone: '(303) 555-0100',
  origin_zip: '80216', notes: 'Two racks of R740s',
};

type Call = { method: string; params: Record<string, unknown> };

describe('website lead alerts on Telegram', () => {
  let calls: Call[];
  let refuse: string | null;
  const telegram: TelegramCall = async <T>(method: string, params: Record<string, unknown>) => {
    if (refuse && params.chat_id === refuse) throw new TelegramError('CHAT_WRITE_FORBIDDEN', 403, null);
    calls.push({ method, params });
    return (method === 'getUpdates' ? [] : { message_id: calls.length }) as T;
  };
  const env = { ...testEnv, FB_CHAT_TELEGRAM_CHAT_ID: CHAT } as typeof testEnv;
  const tick = (over: Partial<typeof env> = {}) => runFbChatTelegramTick(getTestDb(), fbChatTelegramConfig({ ...env, ...over })!);
  const sentTexts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text));

  beforeEach(async () => {
    await resetDb();
    calls = [];
    refuse = null;
    resetLeadRetryForTests();
    setFbChatTelegramForTests(telegram);
  });
  afterEach(() => setFbChatTelegramForTests(null));

  it('posts a sell lot to General once, with its lines', async () => {
    const r = await post<{ ref: string }>('intake', { email: 'seller@example.com', source: 'reddit', lines: [ramLine] });
    expect(r.status).toBe(201);

    await tick();
    const texts = sentTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`New sell request ${r.body.ref} · ram4cash.com`);
    expect(texts[0]).toContain('seller@example.com');
    expect(texts[0]).toContain('Source: reddit');
    expect(texts[0]).toContain('• 24× RAM Samsung 32GB 2933 [M393A4K40CB2-CVF]');
    const msg = calls.find((c) => c.method === 'sendMessage')!;
    expect(msg.params.chat_id).toBe(CHAT);
    expect(msg.params.message_thread_id).toBeUndefined();

    await tick();
    expect(sentTexts()).toHaveLength(1);
  });

  it('posts a quote request with the contact', async () => {
    const r = await post<{ ref: string }>('quote', quote);
    expect(r.status).toBe(201);
    await tick();
    const [text] = sentTexts();
    expect(text).toContain(`New quote request ${r.body.ref} · recycleservers.com`);
    expect(text).toContain('Name: Dana Ops (Acme DC) · business');
    expect(text).toContain('Phone: (303) 555-0100');
    expect(text).toContain('Hardware: Servers, Networking');
    expect(text).toContain('Notes: Two racks of R740s');
  });

  it('posts to the dedicated lead chat when one is set, and account alerts stay in the hub group', async () => {
    const LEADS = '-1005550001';
    const r = await post<{ ref: string }>('quote', quote);
    await getTestDb()`INSERT INTO fb_chat_events (kind, alert) VALUES ('restricted', 'account alert')`;
    await tick({ WEB_LEAD_TELEGRAM_CHAT_ID: LEADS });
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.map((c) => [c.params.chat_id, String(c.params.text).split('\n')[0]])).toEqual([
      [LEADS, `🟢 New quote request ${r.body.ref} · recycleservers.com`],
      [CHAT, 'account alert'],
    ]);
  });

  it('keeps a lead the lead chat refused, without holding up other alerts', async () => {
    const LEADS = '-1005550002';
    refuse = LEADS;
    await post('quote', quote);
    await getTestDb()`INSERT INTO fb_chat_events (kind, alert) VALUES ('restricted', 'account alert')`;
    await tick({ WEB_LEAD_TELEGRAM_CHAT_ID: LEADS });
    expect(sentTexts()).toEqual(['account alert']);
    const [lead] = await getTestDb()`SELECT alerted_at FROM fb_chat_events WHERE kind = 'web_lead'`;
    expect(lead.alerted_at).toBeNull();

    refuse = null;
    resetLeadRetryForTests();
    await tick({ WEB_LEAD_TELEGRAM_CHAT_ID: LEADS });
    expect(calls.at(-1)!.params.chat_id).toBe(LEADS);
  });

  it('queues nothing for a refused or honeypot submission', async () => {
    expect((await post('quote', { ...quote, email: 'nope' })).status).toBe(400);
    expect((await post('intake', { email: 'bot@example.com', website: 'x', lines: [ramLine] })).status).toBe(200);
    expect(await getTestDb()`SELECT 1 FROM fb_chat_events WHERE kind = 'web_lead'`).toHaveLength(0);
  });

  it('keeps the alert waiting while the hub is unconfigured', async () => {
    setFbChatTelegramForTests(null);
    const r = await post<{ ref: string }>('quote', quote);
    const [row] = await getTestDb()<{ detail: { submission_id: string }; alerted_at: Date | null }[]>`
      SELECT detail, alerted_at FROM fb_chat_events WHERE kind = 'web_lead'`;
    expect(row.detail.submission_id).toBe(r.body.ref);
    expect(row.alerted_at).toBeNull();
  });
});

describe('formatWebLead', () => {
  it('names the pickup city and caps a long note', () => {
    const text = formatWebLead({
      kind: 'sell_lot', ref: 'WS-9', photos: 1,
      payload: {
        email: 'a@b.example', notes: 'x'.repeat(2000), source: 'web', handoff: 'pickup',
        pickup_location: 'Denver', lines: [{ category: 'SSD', qty: 1, fields: {} }],
      },
    });
    expect(text).toContain('Handoff: pickup in Denver');
    expect(text).toContain('1 line · 1 unit · 1 photo');
    expect(text).toContain('• 1× SSD');
    expect(text.length).toBeLessThan(800);
  });
});
