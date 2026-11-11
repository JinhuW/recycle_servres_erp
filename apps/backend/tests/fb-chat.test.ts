import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FbChatClaimAnswer, FbChatRow, FbChatSyncAnswer, FbChatSyncPush } from '@recycle-erp/shared';
import { chunkForTelegram, fbChatTopicName } from '../src/lib/fbChat';
import { TelegramError, type TelegramCall } from '../src/lib/telegramBot';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { fbChatTelegramConfig, runFbChatTelegramTick, setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

const CHAT = '-1001234';
const ACCOUNT = { fbUid: '100042', label: 'Denver profile', extVersion: '0.1.0' };
const OTHER = { fbUid: '100077', label: 'Aurora profile' };

const row = (direction: 'in' | 'out', text: string, images: string[] = []): FbChatRow => ({ direction, text, images });

function sync(rows: FbChatRow[], over: Partial<FbChatSyncPush['thread']> = {}, account: FbChatSyncPush['account'] = ACCOUNT): FbChatSyncPush {
  return {
    account,
    thread: {
      fbThreadId: 't1',
      buyer: { name: 'John Smith', profileId: '555', location: 'Aurora, Colorado', joinedYear: 2012, rating: 4.6, ratingCount: 12 },
      listing: { id: '9988', title: 'Dell R740 256GB' },
      rows,
      full: false,
      complete: false,
      ...over,
    },
  };
}

type Call = { method: string; params: Record<string, unknown> };

describe('Facebook chat hub (/api/fb-chat)', () => {
  let bearer: string;
  let wrongScope: string;
  let calls: Call[];
  let updates: unknown[];
  let fail: ((c: Call) => Error | null) | null;
  let topicSeq: number;

  const env = { ...testEnv, FB_CHAT_TELEGRAM_CHAT_ID: CHAT } as typeof testEnv;
  const push = <T>(path: string, body: unknown, token = bearer) =>
    api<T>('POST', `/api/fb-chat/push/${path}`, { body, headers: { authorization: `Bearer ${token}`, 'X-Requested-By': '' } });
  const tick = () => runFbChatTelegramTick(getTestDb(), fbChatTelegramConfig(env)!);
  const sent = (method: string) => calls.filter((c) => c.method === method);
  const texts = () => sent('sendMessage').map((c) => String(c.params.text));

  const telegram: TelegramCall = async <T>(method: string, params: Record<string, unknown>) => {
    const call = { method, params };
    const error = fail?.(call);
    if (error) throw error;
    calls.push(call);
    if (method === 'getUpdates') return updates.splice(0) as T;
    if (method === 'createForumTopic') return { message_thread_id: ++topicSeq } as T;
    return true as T;
  };

  let updateId = 0;
  let tgMessageId = 500;
  function topicReply(topic: number, text: string | undefined, from: Record<string, unknown> = {}) {
    updates.push({
      update_id: ++updateId,
      message: {
        message_id: ++tgMessageId, message_thread_id: topic, is_topic_message: true, chat: { id: Number(CHAT) },
        from: { id: 7, is_bot: false, first_name: 'Jin', ...from }, text,
      },
    });
    return tgMessageId;
  }

  /** A thread with one buyer message, mirrored into topic 1. */
  async function seeded() {
    await push('sync', sync([row('in', 'Is this still available?')], { full: true, complete: true }));
    await tick();
    calls.length = 0;
  }

  beforeAll(async () => {
    process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
  });

  beforeEach(async () => {
    await resetDb();
    const tokenEnv = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_OAUTH_KEY__,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as never;
    const sql = getTestDb();
    const [manager] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const mint = async (scopes: Array<'fbchat:write' | 'pool:write'>) => {
      const client = await createOAuthClient(sql, {
        name: `ext ${scopes[0]}`, redirectUris: [], grantTypes: ['client_credentials'], scopes, createdBy: manager!.id, public: false,
      });
      return signAccessToken(tokenEnv, { clientId: client.clientId, userId: null, scopes });
    };
    bearer = await mint(['fbchat:write']);
    wrongScope = await mint(['pool:write']);
    calls = [];
    updates = [];
    fail = null;
    topicSeq = 0;
    setFbChatTelegramForTests(telegram);
  });

  afterEach(() => setFbChatTelegramForTests(null));

  it('guards the push routes by scope and the reads by role', async () => {
    const body = sync([row('in', 'hi')], { full: true });
    expect((await api('POST', '/api/fb-chat/push/sync', { body, headers: { 'X-Requested-By': '' } })).status).toBe(401);
    expect((await push('sync', body, wrongScope)).status).toBe(403);
    expect((await push('sync', body)).status).toBe(200);
    expect((await push('sync', { account: { fbUid: 'nope' } })).status).toBe(400);

    const purchaser = await loginAs(MARCUS);
    expect((await api('GET', '/api/fb-chat/threads', { token: purchaser.token })).status).toBe(403);
    const manager = await loginAs(ALEX);
    const list = await api<{ threads: { buyer_name: string; rating: number }[] }>('GET', '/api/fb-chat/threads', { token: manager.token });
    expect(list.body.threads).toMatchObject([{ buyer_name: 'John Smith', rating: 4.6 }]);
  });

  it('asks for the whole conversation before storing a new thread', async () => {
    const first = await push<FbChatSyncAnswer>('sync', sync([row('in', 'latest')]));
    expect(first.body).toEqual({ needsFull: true, added: 0 });
    expect(await getTestDb()`SELECT 1 FROM fb_chat_threads`).toHaveLength(0);

    const full = await push<FbChatSyncAnswer>('sync', sync([row('in', 'first'), row('out', 'reply'), row('in', 'latest')], { full: true, complete: true }));
    expect(full.body).toEqual({ needsFull: false, added: 3 });
  });

  it('opens one topic named buyer and location, with a header and the history', async () => {
    await push('sync', sync([row('in', 'first'), row('out', 'reply'), row('in', 'latest')], { full: true, complete: true }));
    await tick();
    expect(sent('createForumTopic').map((c) => c.params)).toEqual([{ chat_id: CHAT, name: 'John Smith · Aurora, Colorado' }]);
    const [head, history] = texts();
    expect(head).toContain('👤 John Smith · ⭐ 4.6 (12 ratings)');
    expect(head).toContain('📍 Aurora, Colorado · on Facebook since 2012');
    expect(head).toContain('https://www.facebook.com/marketplace/item/9988/');
    expect(head).toContain('🔑 Account: Denver profile');
    expect(history).toBe('📜 Earlier messages\nJohn Smith: first\nYou: reply\nJohn Smith: latest');
    expect(sent('sendMessage').every((c) => c.params.message_thread_id === 1)).toBe(true);

    calls.length = 0;
    await tick();
    expect(sent('sendMessage')).toHaveLength(0);
  });

  it('posts only what it has not seen, each once', async () => {
    await seeded();
    const window = [row('in', 'Is this still available?'), row('in', 'ok'), row('in', 'ok')];
    expect((await push<FbChatSyncAnswer>('sync', sync(window))).body.added).toBe(2);
    expect((await push<FbChatSyncAnswer>('sync', sync(window))).body.added).toBe(0);
    await tick();
    expect(texts()).toEqual(['ok', 'ok']);
    expect(sent('createForumTopic')).toHaveLength(0);
  });

  it('mirrors a reply typed on Facebook, and a photo', async () => {
    await seeded();
    await push('sync', sync([row('in', 'Is this still available?'), row('out', 'Yes it is'), row('in', '', ['https://scontent.fbcdn.net/a.jpg'])]));
    await tick();
    expect(texts()).toEqual(['↩️ You: Yes it is']);
    expect(sent('sendPhoto').map((c) => c.params.photo)).toEqual(['https://scontent.fbcdn.net/a.jpg']);
  });

  it('keeps a thread per account even when Facebook reuses the id', async () => {
    await seeded();
    await push('sync', sync([row('in', 'other account')], { full: true, complete: true }, OTHER));
    await tick();
    expect(sent('createForumTopic')).toHaveLength(1);
    expect(await getTestDb()`SELECT 1 FROM fb_chat_threads`).toHaveLength(2);
    // The same Marketplace profile is one buyer across both accounts.
    expect(await getTestDb()`SELECT 1 FROM fb_chat_buyers`).toHaveLength(1);
  });

  it('hands a topic reply to the account that owns the thread, once', async () => {
    await seeded();
    const tgId = topicReply(1, 'Yes, still available');
    topicReply(1, '/note internal');
    topicReply(1, undefined);
    topicReply(99, 'unknown topic');
    updates.push({ update_id: ++updateId, message: { message_id: 1, chat: { id: Number(CHAT) }, from: { id: 7, is_bot: false }, text: 'in General' } });
    expect((await tick()).queued).toBe(1);
    expect(texts()).toEqual(['Only text can be sent to Facebook. This message was not forwarded.']);

    expect((await push('outbox/claim', { account: OTHER })).status).toBe(204);
    const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
    expect(claim.body).toMatchObject({ fbThreadId: 't1', body: 'Yes, still available' });
    expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);

    expect((await push(`outbox/${claim.body.id}/result`, { account: OTHER, outcome: 'sent' })).status).toBe(404);
    expect((await push(`outbox/${claim.body.id}/result`, { account: ACCOUNT, outcome: 'sent', typingMs: 4200 })).status).toBe(200);
    calls.length = 0;
    await tick();
    expect(sent('setMessageReaction').map((c) => c.params.message_id)).toEqual([tgId]);

    // The bubble then shows up in the next window: stored, not posted again.
    const again = await push<FbChatSyncAnswer>('sync', sync([row('in', 'Is this still available?'), row('out', 'Yes, still available')]));
    expect(again.body.added).toBe(0);
    await tick();
    expect(texts()).toEqual([]);
    const [m] = await getTestDb()`SELECT seq, send_state, typing_ms, source FROM fb_chat_messages WHERE source = 'telegram'`;
    expect(m).toMatchObject({ seq: 2, send_state: 'sent', typing_ms: 4200 });
  });

  it('settles a reply from the page when the window arrives before the result', async () => {
    await seeded();
    topicReply(1, 'Can do 800');
    await tick();
    const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
    const early = await push<FbChatSyncAnswer>('sync', sync([row('in', 'Is this still available?'), row('out', 'Can do 800')]));
    expect(early.body.added).toBe(0);
    expect((await push(`outbox/${claim.body.id}/result`, { account: ACCOUNT, outcome: 'sent' })).status).toBe(200);
    expect(await getTestDb()`SELECT 1 FROM fb_chat_messages WHERE direction = 'out'`).toHaveLength(1);
  });

  it('reports a failed reply in the topic and never resends a silent claim', async () => {
    await seeded();
    topicReply(1, 'first');
    await tick();
    const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
    await push(`outbox/${claim.body.id}/result`, { account: ACCOUNT, outcome: 'failed', error: 'composer not found' });
    calls.length = 0;
    await tick();
    expect(texts()).toEqual(['❌ Not sent to Facebook: composer not found. Send it again to retry.']);
    expect((await push(`outbox/${claim.body.id}/result`, { account: ACCOUNT, outcome: 'sent' })).status).toBe(409);

    topicReply(1, 'second');
    await tick();
    await push('outbox/claim', { account: ACCOUNT });
    await getTestDb()`UPDATE fb_chat_messages SET claimed_at = NOW() - INTERVAL '10 minutes' WHERE send_state = 'sending'`;
    expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
    const [m] = await getTestDb()`SELECT send_state FROM fb_chat_messages WHERE body = 'second'`;
    expect(m!.send_state).toBe('uncertain');
  });

  it('only lets listed Telegram users reply when a list is set', async () => {
    await seeded();
    topicReply(1, 'from a stranger', { id: 8 });
    topicReply(1, 'from the owner', { id: 7 });
    const cfg = fbChatTelegramConfig({ ...env, FB_CHAT_TELEGRAM_USER_IDS: '7, 9' } as typeof env)!;
    expect((await runFbChatTelegramTick(getTestDb(), cfg)).queued).toBe(1);
  });

  it('records a rating change and renames the topic when the location arrives', async () => {
    await push('sync', sync([row('in', 'hi')], {
      full: true, complete: true,
      buyer: { name: 'Ana Lee', profileId: '777', location: null, joinedYear: null, rating: null, ratingCount: null },
    }));
    await tick();
    expect(sent('createForumTopic')[0]!.params.name).toBe('Ana Lee');
    const profile = { name: null, profileId: '777', location: 'Denver, Colorado', joinedYear: 2015, rating: 4.9, ratingCount: 31 };
    expect((await push('buyer', { account: ACCOUNT, fbThreadId: 't1', buyer: profile })).status).toBe(200);
    expect((await push('buyer', { account: ACCOUNT, fbThreadId: 'missing', buyer: profile })).status).toBe(404);
    await tick();
    expect(sent('editForumTopic').map((c) => c.params.name)).toEqual(['Ana Lee · Denver, Colorado']);
    const events = await getTestDb()`SELECT detail FROM fb_chat_events WHERE kind = 'buyer_rating'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ rating: 4.9, rating_count: 31, previous_rating: null });
    const [buyer] = await getTestDb()`SELECT name, rating::float8 AS rating, joined_year FROM fb_chat_buyers`;
    expect(buyer).toMatchObject({ name: 'Ana Lee', rating: 4.9, joined_year: 2015 });
  });

  it('alerts once for a checkpoint and again when the account is back', async () => {
    await seeded();
    const event = { account: ACCOUNT, kind: 'restricted', detail: { restriction: 'checkpoint', url: 'https://www.facebook.com/checkpoint/1' } };
    await push('events', event);
    await push('events', event);
    await tick();
    expect(texts()).toEqual(['⚠️ Denver profile: Facebook is showing a checkpoint page. Replies for this account wait until it is cleared in the browser.']);
    expect(sent('sendMessage')[0]!.params.message_thread_id).toBeUndefined();
    calls.length = 0;
    await push('sync', sync([row('in', 'Is this still available?')]));
    await tick();
    expect(texts()).toEqual(['✅ Denver profile: Facebook is reachable again.']);
    expect((await push('events', { account: ACCOUNT, kind: 'bogus' })).status).toBe(400);
  });

  it('opens a new topic when the old one was deleted in Telegram', async () => {
    await seeded();
    await push('sync', sync([row('in', 'Is this still available?'), row('in', 'hello?')]));
    fail = (c) => (c.method === 'sendMessage' && c.params.message_thread_id === 1
      ? new TelegramError('Bad Request: message thread not found', 400, null) : null);
    await tick();
    await tick();
    expect(sent('createForumTopic')).toHaveLength(1);
    expect(texts().at(-1)).toBe('hello?');
    expect(sent('sendMessage').every((c) => c.params.message_thread_id === 2)).toBe(true);
  });

  it('stores everything and calls nothing when Telegram is not configured', async () => {
    expect(fbChatTelegramConfig(testEnv)).toBeNull();
    const status = await api<{ telegram: boolean }>('GET', '/api/fb-chat/push/status', { headers: { authorization: `Bearer ${bearer}` } });
    expect(status.body).toEqual({ ok: true, telegram: false });
    expect((await push<FbChatSyncAnswer>('sync', sync([row('in', 'hi')], { full: true }))).body.added).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('names topics and cuts long text within Telegram limits', () => {
    expect(fbChatTopicName(null, null, 't9')).toBe('Buyer t9');
    expect(fbChatTopicName('A'.repeat(200), 'Denver', 't9')).toHaveLength(128);
    const chunks = chunkForTelegram(Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4000 && !c.startsWith('\n'))).toBe(true);
  });
});
