import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FbChatClaimAnswer, FbChatRow, FbChatSyncAnswer, FbChatSyncPush } from '@recycle-erp/shared';
import type { FbChatConfigAnswer, FbChatConfigField, FbChatDevice, FbChatDeviceAnswer, FbChatEnrollAnswer } from '@recycle-erp/shared';
import {
  fbChatAccountStatus,
  type FbChatAccountsAnswer, type FbChatDeviceRow, type FbChatMessagesAnswer, type FbChatReplyAnswer, type FbChatSummary,
  type FbChatTelegramStatus, type FbChatThreadsAnswer,
} from '@recycle-erp/shared';
import { chunkForTelegram, fbChatTopicName } from '../src/lib/fbChat';
import { setHoldsDraining } from '../src/lib/pgWake';
import { TelegramError, type TelegramCall } from '../src/lib/telegramBot';
import { userAccountCaller, type TelegramUserClient } from '../src/lib/telegramUser';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { alignWindow } from '../src/services/fbChat';
import { compareVersions } from '../src/services/fbChatConfig';
import { fbChatTelegramConfig, fbChatTelegramConfigured, fbChatUserSession, runFbChatTelegramTick, setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, SOFIA, loginAs } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

const CHAT = '-1001234567';
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

describe('alignWindow', () => {
  const m = (d: string, b: string) => ({ direction: d, body: b });
  it('finds the longest end-of-conversation run the window starts with', () => {
    expect(alignWindow([m('in', 'a'), m('out', 'b'), m('in', 'c')], [m('out', 'b'), m('in', 'c'), m('in', 'd')])).toBe(2);
    expect(alignWindow([m('in', 'a')], [m('in', 'x')])).toBe(0);
    expect(alignWindow([], [m('in', 'x')])).toBe(0);
  });
  it('keeps repeats: two "ok"s after one stored "ok" leave one new', () => {
    expect(alignWindow([m('in', 'hi'), m('in', 'ok')], [m('in', 'hi'), m('in', 'ok'), m('in', 'ok')])).toBe(2);
    expect(alignWindow([m('in', 'ok'), m('in', 'ok')], [m('in', 'ok'), m('in', 'ok'), m('in', 'ok')])).toBe(2);
  });
});

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
    // A conversation has no address on Facebook, so the header links none.
    expect(head).not.toContain('/marketplace/t/');
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
    expect(texts()).toEqual(['👤 John Smith: ok', '👤 John Smith: ok']);
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

  // The hold re-checks only every 5 s, so an answer inside a second means the
  // NOTIFY woke it.
  it('wakes a held claim within a second of a reply being queued', async () => {
    await seeded();
    const held = push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT, wait: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const typed = Date.now();
    topicReply(1, 'Yes, still available');
    expect((await tick()).queued).toBe(1);
    const claim = await held;
    expect(Date.now() - typed).toBeLessThan(1000);
    expect(claim.body).toMatchObject({ fbThreadId: 't1', body: 'Yes, still available' });
  });

  it('wakes a held claim when the send ahead of it is reported', async () => {
    await seeded();
    topicReply(1, 'first');
    topicReply(1, 'second');
    await tick();
    const first = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
    const held = push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT, wait: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const reported = Date.now();
    await push(`outbox/${first.body.id}/result`, { account: ACCOUNT, outcome: 'sent' });
    expect((await held).body).toMatchObject({ body: 'second' });
    expect(Date.now() - reported).toBeLessThan(1000);
  });

  it('holds replies while the account is restricted and wakes a held claim when it is back', async () => {
    await seeded();
    topicReply(1, 'Yes, still available');
    await tick();
    await push('events', { account: ACCOUNT, kind: 'restricted', detail: { restriction: 'login' } });
    expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
    const held = push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT, wait: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const recovered = Date.now();
    await push('events', { account: ACCOUNT, kind: 'recovered' });
    expect((await held).body).toMatchObject({ body: 'Yes, still available' });
    expect(Date.now() - recovered).toBeLessThan(1000);
  });

  it('answers a held claim at once when the server starts draining', async () => {
    await seeded();
    const held = push('outbox/claim', { account: ACCOUNT, wait: 20 });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    setHoldsDraining(true);
    try {
      expect((await held).status).toBe(204);
      expect((await push('outbox/claim', { account: ACCOUNT, wait: 20 })).status).toBe(204);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      setHoldsDraining(false);
    }
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
    expect(texts().at(-1)).toBe('👤 John Smith: hello?');
    expect(sent('sendMessage').every((c) => c.params.message_thread_id === 2)).toBe(true);
  });

  it('stores everything and calls nothing when Telegram is not configured', async () => {
    expect(fbChatTelegramConfig(testEnv)).toBeNull();
    const status = await api<{ telegram: boolean }>('GET', '/api/fb-chat/push/status', { headers: { authorization: `Bearer ${bearer}` } });
    expect(status.body).toEqual({ ok: true, telegram: false });
    expect((await push<FbChatSyncAnswer>('sync', sync([row('in', 'hi')], { full: true }))).body.added).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('takes what the extension sends: a client-credentials token, a title key and message times', async () => {
    const sql = getTestDb();
    const [manager] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const client = await createOAuthClient(sql, {
      name: 'extension', redirectUris: [], grantTypes: ['client_credentials'], scopes: ['fbchat:write'], createdBy: manager!.id, public: false,
    });
    const minted = await api<{ access_token: string }>('POST', '/oauth/token', {
      form: { grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret!, scope: 'fbchat:write' },
    });
    expect(minted.status).toBe(200);
    // Byte for byte what the extension's end-to-end run pushed.
    const body = {
      account: { fbUid: '100000000000042', label: 'E2E profile', extVersion: '0.1.0' },
      thread: {
        fbThreadId: 'k7e601ec8e0ef7cac16',
        buyer: { name: 'Kane Bryant', profileId: '61570000000001', location: null, joinedYear: null, rating: null, ratingCount: null },
        listing: { id: '9988776655', title: 'Dell R740 256GB' },
        rows: [
          { direction: 'in', text: '', images: ['https://scontent.fbcdn.net/photo.jpg'], at: 'Tuesday 5:57pm' },
          { direction: 'in', text: 'Is this still available?', images: [], at: 'Tuesday 5:58pm' },
        ],
        full: true,
        complete: true,
      },
    };
    const pushed = await push<FbChatSyncAnswer>('sync', body, minted.body.access_token);
    expect(pushed.body).toEqual({ needsFull: false, added: 2 });
    const labels = await sql`SELECT fb_sent_label FROM fb_chat_messages ORDER BY seq`;
    expect(labels.map((r) => r.fb_sent_label)).toEqual(['Tuesday 5:57pm', 'Tuesday 5:58pm']);
    await tick();
    expect(texts().at(-1)).toBe('📜 Earlier messages\n[Tuesday 5:57pm] Kane Bryant: [photo]\n[Tuesday 5:58pm] Kane Bryant: Is this still available?');
  });

  it('runs as a Telegram account: its own cursor, its own posts ignored, replies relayed', async () => {
    const posted: string[] = [];
    const soon = Math.floor(Date.now() / 1000) + 60;
    let history = [{ id: 300, date: 1, topicId: null as number | null, out: false, fromId: '7', text: 'old chatter in General' }];
    const client: TelegramUserClient = {
      async history(afterId) { return afterId === 0 ? history.slice(-1) : history.filter((m) => m.id > afterId); },
      async send(text) { posted.push(text); return 0; },
      async sendPhotoUrl() { return 0; },
      async createTopic() { return 41; },
      async renameTopic() {},
      async react() {},
      onActivity() {},
    };
    const cfg = { call: userAccountCaller(client, CHAT), chatId: CHAT, userIds: new Set<string>(), mode: 'user' as const };
    await push('sync', sync([row('in', 'Is this still available?')], { full: true, complete: true }));
    await runFbChatTelegramTick(getTestDb(), cfg);
    expect(posted[0]).toContain('👤 John Smith');
    const [state] = await getTestDb()`SELECT "offset", user_last_message_id FROM fb_chat_telegram_state`;
    expect(state).toMatchObject({ offset: '0', user_last_message_id: '301' });

    history = [...history,
      // Posted before this session started (as after a restart): a post.
      { id: 301, date: 1, topicId: 41, out: true, fromId: '5', text: '👤 John Smith' },
      { id: 302, date: soon, topicId: 41, out: false, fromId: '7', text: 'Yes, still available' }];
    // A new cfg reads at once rather than waiting out the catch-up interval.
    const fresh = { ...cfg, call: userAccountCaller(client, CHAT) };
    expect((await runFbChatTelegramTick(getTestDb(), fresh)).queued).toBe(1);
    const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
    expect(claim.body).toMatchObject({ fbThreadId: 't1', body: 'Yes, still available' });

    // Typed on a phone signed in to the hub's own account: out, but not a post.
    history = [...history, { id: 303, date: soon, topicId: 41, out: true, fromId: '5', text: 'nope' }];
    client.onActivity = () => {};
    const again = { ...cfg, call: userAccountCaller(client, CHAT) };
    expect((await runFbChatTelegramTick(getTestDb(), again)).queued).toBe(1);
    const [typed] = await getTestDb()`SELECT body, tg_message_id FROM fb_chat_messages WHERE tg_message_id = 303`;
    expect(typed).toMatchObject({ body: 'nope', tg_message_id: '303' });
  });

  it('counts an account session as configured, and needs all of it', () => {
    const base = { ...testEnv, FB_CHAT_TELEGRAM_CHAT_ID: CHAT } as typeof testEnv;
    const session = { ...base, FB_CHAT_TELEGRAM_API_ID: '123', FB_CHAT_TELEGRAM_API_HASH: 'abc', FB_CHAT_TELEGRAM_SESSION: 's' } as typeof testEnv;
    expect(fbChatUserSession(session)).toEqual({ apiId: 123, apiHash: 'abc', session: 's', chatId: CHAT });
    expect(fbChatUserSession({ ...session, FB_CHAT_TELEGRAM_SESSION: '' } as typeof testEnv)).toBeNull();
    expect(fbChatUserSession({ ...session, FB_CHAT_TELEGRAM_API_ID: 'x' } as typeof testEnv)).toBeNull();
    // A plain group's id: Topics is off, or it is the id from before it was turned on.
    expect(fbChatUserSession({ ...session, FB_CHAT_TELEGRAM_CHAT_ID: '-5324994024' } as typeof testEnv)).toBeNull();
    setFbChatTelegramForTests(null);
    expect(fbChatTelegramConfigured(base)).toBe(false);
    expect(fbChatTelegramConfigured(session)).toBe(true);
  });

  it('names topics and cuts long text within Telegram limits', () => {
    expect(fbChatTopicName(null, null, 't9')).toBe('Buyer t9');
    expect(fbChatTopicName('A'.repeat(200), 'Denver', 't9')).toHaveLength(128);
    const chunks = chunkForTelegram(Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4000 && !c.startsWith('\n'))).toBe(true);
  });
  describe('enrollment', () => {
    const enroll = (body: unknown = { label: 'Office', extVersion: '0.3.0' }, ip = '203.0.113.7') =>
      api<FbChatEnrollAnswer>('POST', '/api/fb-chat/enroll', { body, headers: { 'X-Requested-By': '', 'x-client-ip': ip } });
    const deviceBearer = (e: FbChatEnrollAnswer) => `fbd_${e.deviceId}_${e.token}`;
    const decide = async (id: string, decision: string) =>
      api('POST', `/api/fb-chat/devices/${id}/${decision}`, { token: (await loginAs(ALEX)).token });

    it('lets a device push only once a manager approves it', async () => {
      const e = (await enroll()).body;
      expect(e.status).toBe('pending');
      expect(e.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
      expect(await getTestDb()`SELECT 1 FROM fb_chat_devices WHERE token_hash = ${e.token}`).toHaveLength(0);

      const body = sync([row('in', 'hi')], { full: true });
      const refused = await push<{ error: string }>('sync', body, deviceBearer(e));
      expect(refused).toMatchObject({ status: 403, body: { error: 'device_pending' } });
      const hello = await push<FbChatDeviceAnswer>('device', { fbUid: '100001', label: 'Office Mac' }, deviceBearer(e));
      expect(hello.body).toEqual({ deviceId: e.deviceId, code: e.code, status: 'pending' });

      const manager = await loginAs(ALEX);
      const list = await api<{ devices: FbChatDevice[] }>('GET', '/api/fb-chat/devices', { token: manager.token });
      expect(list.body.devices).toMatchObject([{ id: e.deviceId, code: e.code, label: 'Office Mac', fb_uid: '100001', created_ip: '203.0.113.7' }]);
      const purchaser = await loginAs(MARCUS);
      expect((await api('GET', '/api/fb-chat/devices', { token: purchaser.token })).status).toBe(403);

      expect((await decide(e.deviceId, 'approve')).status).toBe(200);
      expect((await push('sync', body, deviceBearer(e))).status).toBe(200);
      const [acct] = await getTestDb()`SELECT client_id FROM fb_chat_accounts`;
      expect(acct!.client_id).toBe(`device:${e.deviceId}`);

      expect((await decide(e.deviceId, 'revoke')).status).toBe(200);
      expect((await push<{ error: string }>('sync', body, deviceBearer(e))).body).toEqual({ error: 'device_rejected' });
      expect((await push<FbChatDeviceAnswer>('device', {}, deviceBearer(e))).body.status).toBe('revoked');
    });

    it('refuses a rejected device, a wrong token and a deleted one', async () => {
      const e = (await enroll()).body;
      expect((await decide(e.deviceId, 'reject')).status).toBe(200);
      expect((await decide(e.deviceId, 'revoke')).status).toBe(409);
      expect((await push<{ error: string }>('sync', sync([row('in', 'hi')]), deviceBearer(e))).body).toEqual({ error: 'device_rejected' });

      const forged = `fbd_${e.deviceId}_${'A'.repeat(43)}`;
      expect((await push('device', {}, forged)).status).toBe(401);
      const manager = await loginAs(ALEX);
      expect((await api('DELETE', `/api/fb-chat/devices/${e.deviceId}`, { token: manager.token })).status).toBe(200);
      expect((await push('device', {}, deviceBearer(e))).status).toBe(401);
    });

    it('bounds enrollment per address and in waiting requests', async () => {
      const sql = getTestDb();
      for (let i = 0; i < 5; i++) expect((await enroll(undefined, '198.51.100.1')).status).toBe(200);
      expect((await enroll(undefined, '198.51.100.1')).body).toMatchObject({ detail: 'ip_limit' });
      // An hour on, the address still holds five waiting requests.
      await sql`UPDATE fb_chat_devices SET created_at = NOW() - INTERVAL '2 hours'`;
      expect((await enroll(undefined, '198.51.100.1')).body).toMatchObject({ detail: 'ip_limit' });

      await sql`
        INSERT INTO fb_chat_devices (id, token_hash, code, label, ip_key)
        SELECT lpad(to_hex(g), 18, '0'), md5(g::text), 'AAAA-AAAA', '', 'filler-' || g FROM generate_series(1, 95) g`;
      expect((await enroll(undefined, '198.51.100.99')).body).toMatchObject({ detail: 'pending_limit' });
      // Requests nobody's extension is asking about any more stop holding the list shut.
      await sql`UPDATE fb_chat_devices SET last_seen_at = NOW() - INTERVAL '2 hours' WHERE ip_key LIKE 'filler-%'`;
      expect((await enroll(undefined, '198.51.100.99')).status).toBe(200);
      expect(await sql`SELECT 1 FROM fb_chat_devices WHERE ip_key LIKE 'filler-%'`).toHaveLength(0);
    });

    it('lets requests arriving together pass the limit no further', async () => {
      const answers = await Promise.all(Array.from({ length: 8 }, () => enroll(undefined, '198.51.100.2')));
      expect(answers.filter((a) => a.status === 200)).toHaveLength(5);
    });

    it('takes no session and needs no CSRF header to enroll', async () => {
      const r = await api('POST', '/api/fb-chat/enroll', { body: 'not json', headers: { 'X-Requested-By': '' } });
      expect(r.status).toBe(200);
    });
  });

  describe('remote settings', () => {
    const FIELDS: FbChatConfigField[] = [
      { key: 'paused', label: 'Paused', type: 'boolean', default: false },
      { key: 'minSendIntervalSec', label: 'Time between replies', type: 'integer', default: 20, min: 10, max: 600, unit: 's' },
    ];
    const ask = (account?: typeof ACCOUNT, fields = FIELDS, extVersion = '0.2.0') =>
      push<FbChatConfigAnswer>('config', { account, extVersion, fields });
    type Page = {
      fields: Array<FbChatConfigField & { versions: string[] }>;
      entries: Array<{ account_id: number | null; key: string; value: unknown; updated_by: string | null }>;
      accounts: Array<{ id: number; label: string; config_rev: string | null; expected_rev: string }>;
    };
    const page = async (token: string) => (await api<Page>('GET', '/api/fb-chat/config', { token })).body;

    it('answers an extension before it knows its account, and with nothing set', async () => {
      const first = await ask();
      expect(first.status).toBe(200);
      expect(first.body.values).toEqual({});
      const again = await ask();
      expect(again.body.rev).toBe(first.body.rev);
    });

    it('draws the settings page from the fields the extensions report', async () => {
      await ask(ACCOUNT, [FIELDS[0]!], '0.1.9');
      await ask(ACCOUNT);
      const manager = await loginAs(ALEX);
      const { fields, accounts } = await page(manager.token);
      expect(fields.map((f) => f.key)).toEqual(['paused', 'minSendIntervalSec']);
      expect(fields[0]!.versions).toEqual(['0.2.0', '0.1.9']);
      expect(fields[1]!).toMatchObject({ min: 10, max: 600, unit: 's', versions: ['0.2.0'] });
      expect(accounts.map((a) => a.label)).toEqual(['Denver profile']);
    });

    it('hands each profile the shared values with its own on top, and the revision follows', async () => {
      const before = (await ask(ACCOUNT)).body.rev;
      await ask(OTHER);
      const manager = await loginAs(ALEX);
      const accounts = (await page(manager.token)).accounts;
      const denver = accounts.find((a) => a.label === 'Denver profile')!;
      expect(denver.config_rev).toBe(before);
      expect(denver.expected_rev).toBe(before);

      const put = (key: string, value: unknown, accountId: number | null = null) =>
        api('PUT', `/api/fb-chat/config/${key}`, { token: manager.token, body: { accountId, value } });
      expect((await put('minSendIntervalSec', 30)).status).toBe(200);
      expect((await put('minSendIntervalSec', 45, denver.id)).status).toBe(200);

      // The page knows the profile has not picked it up yet.
      const pending = (await page(manager.token)).accounts.find((a) => a.id === denver.id)!;
      expect(pending.expected_rev).not.toBe(pending.config_rev);

      const mine = await ask(ACCOUNT);
      expect(mine.body.values).toEqual({ minSendIntervalSec: 45 });
      expect(mine.body.rev).not.toBe(before);
      expect((await ask(OTHER as typeof ACCOUNT)).body.values).toEqual({ minSendIntervalSec: 30 });
      const caught = (await page(manager.token)).accounts.find((a) => a.id === denver.id)!;
      expect(caught.config_rev).toBe(caught.expected_rev);

      // Reset the profile's own value: back to the shared one.
      expect((await api('DELETE', `/api/fb-chat/config/minSendIntervalSec?accountId=${denver.id}`, { token: manager.token })).status).toBe(200);
      expect((await ask(ACCOUNT)).body.values).toEqual({ minSendIntervalSec: 30 });
      const { entries } = await page(manager.token);
      expect(entries).toEqual([expect.objectContaining({ account_id: null, key: 'minSendIntervalSec', value: 30, updated_by: expect.any(String) })]);
    });

    it('refuses a value that does not fit a reported field, and takes an unreported key as given', async () => {
      await ask(ACCOUNT);
      const manager = await loginAs(ALEX);
      const put = (key: string, value: unknown) =>
        api<{ detail?: string }>('PUT', `/api/fb-chat/config/${key}`, { token: manager.token, body: { accountId: null, value } });
      const low = await put('minSendIntervalSec', 5);
      expect(low.status).toBe(400);
      expect(low.body.detail).toBe('Time between replies must be at least 10');
      expect((await put('minSendIntervalSec', 12.5)).status).toBe(400);
      expect((await put('paused', 'yes')).status).toBe(400);
      expect((await put('bad key!', 1)).status).toBe(400);
      expect((await put('futureSetting', { selectors: ['a', 'b'] })).status).toBe(200);
      expect((await put('futureSetting', 'x'.repeat(20_000))).status).toBe(400);
      expect((await ask(ACCOUNT)).body.values).toEqual({ futureSetting: { selectors: ['a', 'b'] } });
      expect((await api('PUT', '/api/fb-chat/config/paused', { token: manager.token, body: { accountId: 999999, value: true } })).status).toBe(404);
    });

    it('guards the settings: the push needs the scope, the page a manager', async () => {
      expect((await push('config', { extVersion: '0.2.0', fields: FIELDS }, wrongScope)).status).toBe(403);
      expect((await push('config', { extVersion: '0.2.0', fields: [{ key: '1bad', type: 'boolean', default: false }] })).status).toBe(400);
      expect((await push('config', { extVersion: '0.2.0', fields: [FIELDS[0], FIELDS[0]] })).status).toBe(400);
      expect((await push('config', { fields: FIELDS })).status).toBe(400);
      const purchaser = await loginAs(MARCUS);
      expect((await api('GET', '/api/fb-chat/config', { token: purchaser.token })).status).toBe(403);
      expect((await api('PUT', '/api/fb-chat/config/paused', { token: purchaser.token, body: { value: true } })).status).toBe(403);
    });

    it('orders extension versions by number', () => {
      expect(['0.10.0', '0.2.0', '0.9.1'].sort((a, b) => compareVersions(b, a))).toEqual(['0.10.0', '0.9.1', '0.2.0']);
    });
  });

  describe('the Leads ▸ Facebook page', () => {
    type Thread = FbChatThreadsAnswer['threads'][number];
    const FIELDS: FbChatConfigField[] = [
      { key: 'paused', label: 'Paused', type: 'boolean', default: false },
      { key: 'configPollSec', label: 'Settings check', type: 'integer', default: 60, min: 30, max: 3600, unit: 's' },
    ];
    let token: string;
    const get = <T>(path: string) => api<T>('GET', `/api/fb-chat/${path}`, { token, env });
    const post = <T>(path: string, body?: unknown) => api<T>('POST', `/api/fb-chat/${path}`, { token, body });
    const threads = async (query = '') => (await get<FbChatThreadsAnswer>(`threads${query}`)).body.threads;
    const thread = async (): Promise<Thread> => (await threads())[0]!;
    const reply = (threadId: number, body: unknown) => post<FbChatReplyAnswer>(`threads/${threadId}/messages`, { body });
    const accounts = async () => (await get<FbChatAccountsAnswer>('accounts')).body;
    const summary = async () => (await get<FbChatSummary>('summary')).body;
    const enroll = async (body: unknown) =>
      (await api<FbChatEnrollAnswer>('POST', '/api/fb-chat/enroll', { body, headers: { 'X-Requested-By': '' } })).body;
    const deviceBearer = (e: FbChatEnrollAnswer) => `fbd_${e.deviceId}_${e.token}`;
    const stateOf = async (id: number) => {
      const [m] = await getTestDb()`SELECT send_state, error, seq, attempts, acked_at FROM fb_chat_messages WHERE id = ${id}`;
      return m!;
    };
    /** Claims the account's next reply and reports how it ended. */
    async function send(outcome: 'sent' | 'failed' | 'uncertain', error?: string) {
      const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
      expect(claim.status).toBe(200);
      expect((await push(`outbox/${claim.body.id}/result`, { account: ACCOUNT, outcome, error })).status).toBe(200);
      return claim.body;
    }

    beforeEach(async () => {
      token = (await loginAs(ALEX)).token;
    });

    it('sends a reply typed in the ERP through the same outbox, and names its author in Telegram', async () => {
      await seeded();
      const t = await thread();
      const queued = await reply(t.id, '  We can do $38 each.  ');
      expect(queued.status).toBe(201);
      expect(queued.body.message).toMatchObject({
        direction: 'out', source: 'erp', body: 'We can do $38 each.', send_state: 'queued', seq: null,
        author_name: 'Alex Chen', erp_user_id: expect.any(String), tg_user_name: null,
      });
      await tick();
      expect(texts()).toEqual(['↩️ Alex (ERP): We can do $38 each.']);
      calls.length = 0;

      const claimed = await send('sent');
      expect(claimed).toEqual({ id: queued.body.message.id, fbThreadId: 't1', body: 'We can do $38 each.', attempt: 1 });
      // Sent needs no word in Telegram: the text is there and the ERP shows the state.
      await tick();
      expect(calls.filter((c) => c.method !== 'getUpdates')).toEqual([]);
      expect((await stateOf(claimed.id)).acked_at).not.toBeNull();

      // The bubble arrives in the next window: the same row, not a new one, and not posted again.
      const again = await push<FbChatSyncAnswer>('sync', sync([row('in', 'Is this still available?'), row('out', 'We can do $38 each.')]));
      expect(again.body.added).toBe(0);
      await tick();
      expect(texts()).toEqual([]);

      const open = await get<FbChatMessagesAnswer>(`threads/${t.id}/messages`);
      expect(open.body.messages.map((m) => [m.seq, m.source, m.send_state, m.author_name])).toEqual([
        [1, 'facebook', null, null], [2, 'erp', 'sent', 'Alex Chen'],
      ]);
      expect(open.body.thread).toMatchObject({
        id: t.id, account_no: 1, account_label: 'Denver profile', unread: false, failed: false,
        telegram_topic_id: 1, telegram_topic_url: 'https://t.me/c/1234567/1',
        last_message: { direction: 'out', source: 'erp', author_name: 'Alex Chen', body: 'We can do $38 each.', images: 0, send_state: 'sent' },
      });
      expect(open.body.also_messaged).toEqual([]);
    });

    it('refuses a reply that is empty, too long or for no chat, and sends a leading slash as typed', async () => {
      await seeded();
      const t = await thread();
      expect((await reply(t.id, '   ')).status).toBe(400);
      expect((await reply(t.id, 42)).status).toBe(400);
      expect((await reply(t.id, 'x'.repeat(2001))).status).toBe(400);
      expect((await reply(999999, 'hello')).status).toBe(404);
      expect((await reply(t.id, 'x'.repeat(2000))).status).toBe(201);
      expect((await reply(t.id, '/note')).body.message.body).toBe('/note');
      expect((await get(`threads/999999/messages`)).status).toBe(404);
    });

    it('holds an ERP reply while the account is restricted, and tells Telegram when it fails', async () => {
      await seeded();
      const t = await thread();
      await push('events', { account: ACCOUNT, kind: 'restricted', detail: { restriction: 'login' } });
      expect((await reply(t.id, 'Still here')).status).toBe(201);
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
      expect((await accounts()).accounts[0]).toMatchObject({ restricted: 'login', replies_waiting: 1 });
      await push('events', { account: ACCOUNT, kind: 'recovered' });
      await tick();
      calls.length = 0;

      await send('failed', 'composer not found');
      await tick();
      expect(texts()).toEqual(["❌ Alex's reply from the ERP was not sent to Facebook: composer not found. Retry it in the ERP."]);
      expect(sent('sendMessage')[0]!.params).toMatchObject({ message_thread_id: 1 });
      expect(sent('sendMessage')[0]!.params.reply_parameters).toBeUndefined();
      calls.length = 0;
      await tick();
      expect(texts()).toEqual([]);
    });

    it('wakes a held claim when a reply is typed in the ERP', async () => {
      await seeded();
      const t = await thread();
      const held = push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT, wait: 10 });
      await new Promise((r) => setTimeout(r, 300));
      const typed = Date.now();
      await reply(t.id, 'Yes, still available');
      expect((await held).body).toMatchObject({ body: 'Yes, still available' });
      expect(Date.now() - typed).toBeLessThan(1000);
    });

    it('retries only a reply that did not go out, and an uncertain one only when forced', async () => {
      await seeded();
      const t = await thread();
      const { id } = (await reply(t.id, 'first try')).body.message;
      const inbound = (await get<FbChatMessagesAnswer>(`threads/${t.id}/messages`)).body.messages[0]!;

      // Queued, sending and inbound rows are not waiting for a retry.
      expect((await post(`messages/${id}/retry`)).status).toBe(409);
      expect((await post(`messages/${inbound.id}/retry`, { force: true })).status).toBe(409);
      expect((await post('messages/999999/retry')).status).toBe(404);

      await send('failed', 'composer not found');
      expect(await thread()).toMatchObject({ failed: true });
      expect((await threads('?filter=failed')).map((x) => x.id)).toEqual([t.id]);
      const retried = await post<FbChatReplyAnswer>(`messages/${id}/retry`);
      expect(retried.status).toBe(200);
      expect(retried.body.message).toMatchObject({ id, source: 'erp', send_state: 'queued', error: null, author_name: 'Alex Chen' });
      expect(await threads('?filter=failed')).toEqual([]);

      // The same row goes out again; this time the browser cannot say whether it landed.
      expect((await send('uncertain')).id).toBe(id);
      expect(await stateOf(id)).toMatchObject({ send_state: 'uncertain', attempts: 2 });
      expect((await threads('?filter=failed')).map((x) => x.id)).toEqual([t.id]);
      const refused = await post<{ error: string; detail: string }>(`messages/${id}/retry`);
      expect(refused.status).toBe(409);
      expect(refused.body.detail).toContain('force');
      expect((await post(`messages/${id}/retry`, { force: 'yes' })).status).toBe(409);
      expect((await stateOf(id)).send_state).toBe('uncertain');
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);

      await tick();
      calls.length = 0;
      expect((await post(`messages/${id}/retry`, { force: true })).status).toBe(200);
      expect((await send('sent')).id).toBe(id);
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2, attempts: 3 });
      // Sent replies are final.
      expect((await post(`messages/${id}/retry`, { force: true })).status).toBe(409);
      // The topic was told it failed, so it is told it landed, once.
      await tick();
      expect(texts()).toEqual(["✅ Alex's reply from the ERP was sent to Facebook after all."]);
      expect(sent('sendMessage')[0]!.params).toMatchObject({ message_thread_id: 1 });
      calls.length = 0;
      await tick();
      expect(texts()).toEqual([]);
    });

    it('queues a reply once when the page sends it again with the same key', async () => {
      await seeded();
      const t = await thread();
      const clientKey = '3f2b8c1e-5a44-4c0e-9d7a-0b1c2d3e4f50';
      const send1 = await post<FbChatReplyAnswer>(`threads/${t.id}/messages`, { body: 'We can do $38 each.', clientKey });
      expect(send1.status).toBe(201);
      // The answer was lost; the page restored the text and the manager pressed Enter again.
      const send2 = await post<FbChatReplyAnswer>(`threads/${t.id}/messages`, { body: 'We can do $38 each.', clientKey });
      expect(send2.status).toBe(200);
      expect(send2.body.message.id).toBe(send1.body.message.id);
      expect(await getTestDb()`SELECT 1 FROM fb_chat_messages WHERE source = 'erp'`).toHaveLength(1);
      await send('sent');
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
      // The same key still answers with that reply once it has gone out.
      const late = await post<FbChatReplyAnswer>(`threads/${t.id}/messages`, { body: 'We can do $38 each.', clientKey });
      expect(late.body.message).toMatchObject({ id: send1.body.message.id, send_state: 'sent' });

      // Another key, or none, is another reply; a key that is not a UUID is refused.
      expect((await post(`threads/${t.id}/messages`, { body: 'We can do $38 each.', clientKey: clientKey.replace('3f', '4f') })).status).toBe(201);
      expect((await reply(t.id, 'We can do $38 each.')).status).toBe(201);
      expect((await reply(t.id, 'We can do $38 each.')).status).toBe(201);
      expect((await post(`threads/${t.id}/messages`, { body: 'hi', clientKey: 'again' })).status).toBe(400);
      expect(await getTestDb()`SELECT 1 FROM fb_chat_messages WHERE source = 'erp'`).toHaveLength(4);
    });

    it('does not send a retried reply again once a window shows it already landed', async () => {
      await seeded();
      const t = await thread();
      const { id } = (await reply(t.id, 'Yes, still available')).body.message;
      await send('uncertain');
      await tick();
      calls.length = 0;
      // The manager sends it again before the next window of the chat arrives.
      expect((await post(`messages/${id}/retry`, { force: true })).status).toBe(200);
      const window = await push<FbChatSyncAnswer>('sync', sync([row('in', 'Is this still available?'), row('out', 'Yes, still available')]));
      expect(window.body.added).toBe(0);
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2, attempts: 1 });
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
      // Not mirrored as a reply typed on Facebook; the topic hears it landed.
      await tick();
      expect(texts()).toEqual(["✅ Alex's reply from the ERP was sent to Facebook after all."]);
    });

    it('ignores a late failure from an earlier attempt while the retry is being typed', async () => {
      await seeded();
      const t = await thread();
      const { id } = (await reply(t.id, 'Yes, still available')).body.message;
      const first = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
      expect(first.body).toMatchObject({ id, attempt: 1 });
      await getTestDb()`UPDATE fb_chat_messages SET claimed_at = NOW() - INTERVAL '1 hour' WHERE id = ${id}`;
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
      expect((await post(`messages/${id}/retry`, { force: true })).status).toBe(200);
      const second = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
      expect(second.body).toMatchObject({ id, attempt: 2 });

      expect((await push(`outbox/${id}/result`, { account: ACCOUNT, outcome: 'failed', attempt: 1 })).status).toBe(200);
      expect((await stateOf(id)).send_state).toBe('sending');
      expect((await push(`outbox/${id}/result`, { account: ACCOUNT, outcome: 'sent', attempt: 2 })).status).toBe(200);
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', attempts: 2 });
    });

    it('refuses a push for an account another approved Chrome relays, until that one is revoked', async () => {
      const owner = await enroll({ label: 'Office', extVersion: '0.3.0' });
      await post(`devices/${owner.deviceId}/approve`);
      const body = sync([row('in', 'hi')], { full: true });
      expect((await push('sync', body, deviceBearer(owner))).status).toBe(200);

      // Approved before its Facebook user was known, with a name and a pause.
      const other = await enroll({ label: 'Laptop', extVersion: '0.3.0' });
      await post(`devices/${other.deviceId}/approve`, { label: 'Renamed', startPaused: true });
      const taken = await push<{ error: string }>('sync', body, deviceBearer(other));
      expect(taken).toMatchObject({ status: 409, body: { error: 'conflict' } });
      expect((await push('outbox/claim', { account: ACCOUNT }, deviceBearer(other))).status).toBe(409);
      const [still] = await getTestDb()`SELECT client_id FROM fb_chat_accounts`;
      expect(still!.client_id).toBe(`device:${owner.deviceId}`);

      // Once the owner is revoked the account moves, keeping its own name and pause.
      await post(`devices/${owner.deviceId}/revoke`);
      expect((await push('sync', body, deviceBearer(other))).status).toBe(200);
      expect((await accounts()).accounts[0]).toMatchObject({ label: 'Denver profile', paused: false, device: { id: other.deviceId } });
      const [device] = await getTestDb()`SELECT account_label, start_paused FROM fb_chat_devices WHERE id = ${other.deviceId}`;
      expect(device).toEqual({ account_label: null, start_paused: false });
      // A later account from that Chrome is not given the name either.
      await push('sync', sync([row('in', 'hey')], { full: true }, OTHER), deviceBearer(other));
      expect((await accounts()).accounts.find((a) => a.fb_uid === OTHER.fbUid)).toMatchObject({ label: 'Aurora profile', paused: false });
    });

    it('takes the browser\'s late word that a retried reply had landed', async () => {
      await seeded();
      const t = await thread();
      const { id } = (await reply(t.id, 'Yes, still available')).body.message;
      const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
      expect(claim.body.id).toBe(id);
      // The browser goes quiet: the next claim finds the send stale.
      await getTestDb()`UPDATE fb_chat_messages SET claimed_at = NOW() - INTERVAL '1 hour' WHERE id = ${id}`;
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
      expect((await stateOf(id)).send_state).toBe('uncertain');
      expect((await post(`messages/${id}/retry`, { force: true })).status).toBe(200);

      // A failure reported for a reply that is back in the queue is still refused.
      expect((await push(`outbox/${id}/result`, { account: ACCOUNT, outcome: 'failed' })).status).toBe(409);
      expect((await push(`outbox/${id}/result`, { account: ACCOUNT, outcome: 'sent' })).status).toBe(200);
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2, attempts: 1 });
      expect((await push('outbox/claim', { account: ACCOUNT })).status).toBe(204);
      expect((await thread()).failed).toBe(false);
    });

    it('lets the release before this one keep upserting accounts without a number', async () => {
      const sql = getTestDb();
      // What touchAccount ran on every push before the number existed.
      const upsert = (fbUid: string, label: string) => sql<{ id: number }[]>`
        INSERT INTO fb_chat_accounts (fb_uid, label, client_id, ext_version)
        VALUES (${fbUid}, ${label}, 'svc', NULL)
        ON CONFLICT (fb_uid) DO UPDATE SET
          label = CASE WHEN EXCLUDED.label <> '' THEN EXCLUDED.label ELSE fb_chat_accounts.label END,
          client_id = EXCLUDED.client_id,
          ext_version = COALESCE(EXCLUDED.ext_version, fb_chat_accounts.ext_version),
          last_seen_at = NOW()
        RETURNING id::int AS id`;
      await seeded();
      // A known account, a new one, the new one again, and two new at once.
      await upsert(ACCOUNT.fbUid, 'Denver renamed');
      await upsert('100700', 'Old release');
      await upsert('100700', 'Old release');
      await Promise.all([upsert('100701', 'a'), upsert('100702', 'b')]);
      await push('outbox/claim', { account: { fbUid: '100703', label: 'New release' } });
      expect((await accounts()).accounts.map((a) => [a.no, a.label])).toEqual([
        [1, 'Denver renamed'], [2, 'Old release'], [3, expect.any(String)], [4, expect.any(String)], [5, 'New release'],
      ]);
    });

    it('retries a reply typed in Telegram from the ERP, and Telegram hears how it ended', async () => {
      await seeded();
      const tgId = topicReply(1, 'Can do 800');
      await tick();
      const failed = await send('failed', 'composer not found');
      await tick();
      calls.length = 0;
      expect((await post(`messages/${failed.id}/retry`)).status).toBe(200);
      await send('sent');
      await tick();
      expect(sent('setMessageReaction').map((c) => c.params.message_id)).toEqual([tgId]);
      const open = await get<FbChatMessagesAnswer>(`threads/${(await thread()).id}/messages`);
      expect(open.body.messages.at(-1)).toMatchObject({ source: 'telegram', author_name: 'Jin', send_state: 'sent' });
    });

    it('keeps one read mark per chat for the whole team', async () => {
      // A chat found ending with the buyer starts unread.
      await seeded();
      const t = await thread();
      expect(t.unread).toBe(true);
      expect(await summary()).toEqual({ unread: 1, pending_devices: 0 });
      expect((await threads('?filter=unread')).map((x) => x.id)).toEqual([t.id]);

      // Opening the conversation is not reading it; saying so is, for everyone.
      await get(`threads/${t.id}/messages`);
      expect((await thread()).unread).toBe(true);
      expect((await post(`threads/${t.id}/read`)).body).toEqual({ ok: true });
      expect((await post(`threads/${t.id}/read`)).status).toBe(200);
      const other = (await loginAs(SOFIA)).token;
      const seenByOther = await api<FbChatThreadsAnswer>('GET', '/api/fb-chat/threads', { token: other });
      expect(seenByOther.body.threads[0]!.unread).toBe(false);
      expect(await threads('?filter=unread')).toEqual([]);
      expect((await summary()).unread).toBe(0);

      expect((await api('POST', `/api/fb-chat/threads/${t.id}/unread`, { token: other })).status).toBe(200);
      expect((await post(`threads/${t.id}/unread`)).status).toBe(200);
      expect((await thread()).unread).toBe(true);
      expect((await accounts()).accounts[0]!.unread).toBe(1);

      // An answer reads it, wherever it is typed: Telegram, the ERP, Facebook.
      topicReply(1, 'Yes');
      await tick();
      expect((await thread()).unread).toBe(false);
      await send('sent');
      await push('sync', sync([row('in', 'Is this still available?'), row('out', 'Yes'), row('in', 'Price?')]));
      expect((await thread()).unread).toBe(true);
      await reply(t.id, '$40');
      expect((await thread()).unread).toBe(false);
      await send('sent');
      await push('sync', sync([row('out', '$40'), row('in', 'Deal?')]));
      expect((await thread()).unread).toBe(true);
      await push('sync', sync([row('in', 'Deal?'), row('out', 'Deal')]));
      expect((await thread()).unread).toBe(false);

      expect((await post('threads/999999/read')).status).toBe(404);
      expect((await post('threads/999999/unread')).status).toBe(404);
    });

    it('leaves a chat we ended read, and unread does nothing where the buyer never wrote', async () => {
      await push('sync', sync([row('in', 'hi'), row('out', 'hello')], { full: true, complete: true }));
      const t = await thread();
      expect(t.unread).toBe(false);
      await push('sync', sync([row('out', 'only us')], { full: true, complete: true, fbThreadId: 't2' }));
      const ours = (await threads()).find((x) => x.fb_thread_id === 't2')!;
      expect((await post(`threads/${ours.id}/unread`)).status).toBe(200);
      expect((await threads('?filter=unread'))).toEqual([]);
      expect((await post(`threads/${t.id}/unread`)).status).toBe(200);
      expect((await threads('?filter=unread')).map((x) => x.id)).toEqual([t.id]);
    });

    it('filters the chat list by account, search and state', async () => {
      await seeded();
      await push('sync', sync([row('in', '100% tested DDR4_32GB sticks')], {
        full: true, complete: true, fbThreadId: 't2',
        buyer: { name: 'Ana Lee', profileId: '777', location: null, joinedYear: null, rating: null, ratingCount: null },
        listing: { id: '77', title: 'Sell your RAM' },
      }, OTHER));
      const all = await threads();
      expect(all.map((x) => x.buyer_name)).toEqual(['Ana Lee', 'John Smith']);
      expect(all.map((x) => x.account_no)).toEqual([2, 1]);
      const denver = all[1]!.account_id;
      expect((await threads(`?account=${denver}`)).map((x) => x.buyer_name)).toEqual(['John Smith']);
      expect((await threads('?q=john')).map((x) => x.buyer_name)).toEqual(['John Smith']);
      expect((await threads('?q=your%20ram')).map((x) => x.buyer_name)).toEqual(['Ana Lee']);
      expect((await threads('?q=STILL%20available')).map((x) => x.buyer_name)).toEqual(['John Smith']);
      // What LIKE would read as wildcards is text to find.
      expect((await threads('?q=100%25%20tested')).map((x) => x.buyer_name)).toEqual(['Ana Lee']);
      expect((await threads('?q=DDR4_32')).map((x) => x.buyer_name)).toEqual(['Ana Lee']);
      expect(await threads('?q=DDR4x32')).toEqual([]);
      expect((await threads('?q=%25')).map((x) => x.buyer_name)).toEqual(['Ana Lee']);
      expect((await threads(`?account=${denver}&filter=unread&q=available`)).map((x) => x.buyer_name)).toEqual(['John Smith']);
      expect((await threads('?filter=all')).length).toBe(2);
      expect((await get('threads?filter=archived')).status).toBe(400);
      expect((await get('threads?account=abc')).status).toBe(400);

      // The same Marketplace profile on another of our accounts.
      await push('sync', sync([row('in', 'Asked about SSD pricing')], { full: true, complete: true, fbThreadId: 't3' }, OTHER));
      const john = (await threads(`?account=${denver}`))[0]!;
      const open = await get<FbChatMessagesAnswer>(`threads/${john.id}/messages`);
      expect(open.body.also_messaged).toMatchObject([{ account_no: 2, account_label: 'Aurora profile', last_body: 'Asked about SSD pricing' }]);
    });

    it('keeps the name a manager gave an account when the extension reports its own', async () => {
      await seeded();
      await push('config', { account: { ...ACCOUNT, label: 'Chrome 1' }, extVersion: '0.3.0', fields: FIELDS });
      const [acct] = (await accounts()).accounts;
      expect(acct!.label).toBe('Chrome 1');

      const rename = (id: number, label: unknown) => api('PATCH', `/api/fb-chat/accounts/${id}`, { token, body: { label } });
      expect((await rename(acct!.id, '  ')).status).toBe(400);
      expect((await rename(acct!.id, 'x'.repeat(61))).status).toBe(400);
      expect((await rename(acct!.id, 7)).status).toBe(400);
      expect((await rename(999999, 'Nobody')).status).toBe(404);
      expect((await rename(acct!.id, '  Westside Parts ')).status).toBe(200);

      await push('sync', sync([row('in', 'Is this still available?'), row('in', 'hello?')]));
      await push('config', { account: ACCOUNT, extVersion: '0.3.0', fields: FIELDS });
      await push('outbox/claim', { account: ACCOUNT });
      const after = (await accounts()).accounts;
      expect(after.map((a) => [a.id, a.no, a.label])).toEqual([[acct!.id, 1, 'Westside Parts']]);
      expect((await thread()).account_label).toBe('Westside Parts');
    });

    it('gives a new account the name and pause chosen at approval, on its first push', async () => {
      const e = await enroll({ label: 'Chrome 3', extVersion: '0.3.0' });
      const approve = (body?: unknown) => post(`devices/${e.deviceId}/approve`, body);
      expect((await approve({ startPaused: 'yes' })).status).toBe(400);
      expect((await approve({ label: 5 })).status).toBe(400);
      expect((await approve({ label: 'x'.repeat(61) })).status).toBe(400);
      expect((await approve([])).status).toBe(400);
      expect((await approve({ label: ' Littleton Lots ', startPaused: true })).status).toBe(200);
      // Approval makes no account: it appears when the Chrome first checks in.
      expect((await accounts()).accounts).toEqual([]);

      const mine = { fbUid: '100500', label: 'Chrome 3', extVersion: '0.3.0' };
      const first = await push<FbChatConfigAnswer>('config', { account: mine, extVersion: '0.3.0', fields: FIELDS }, deviceBearer(e));
      expect(first.body.values).toEqual({ paused: true });
      await push('sync', sync([row('in', 'hi')], { full: true }, mine), deviceBearer(e));

      const [acct] = (await accounts()).accounts;
      expect(acct).toMatchObject({
        no: 1, fb_uid: '100500', label: 'Littleton Lots', paused: true, config_state: 'up_to_date', threads: 1,
        device: { id: e.deviceId, label: 'Chrome 3', status: 'approved', decided_by: 'Alex Chen' },
      });
      const [entry] = (await get<{ entries: { account_id: number; key: string; value: unknown; updated_by: string }[] }>('config')).body.entries;
      expect(entry).toMatchObject({ account_id: acct!.id, key: 'paused', value: true, updated_by: 'Alex Chen' });
      const [device] = await getTestDb()`SELECT account_label, start_paused FROM fb_chat_devices`;
      expect(device).toEqual({ account_label: null, start_paused: false });

      // Resuming sticks: the pause was a starting value, not a rule.
      expect((await api('DELETE', `/api/fb-chat/config/paused?accountId=${acct!.id}`, { token })).status).toBe(200);
      await push('config', { account: mine, extVersion: '0.3.0', fields: FIELDS }, deviceBearer(e));
      expect((await accounts()).accounts[0]).toMatchObject({ label: 'Littleton Lots', paused: false });
    });

    it('approves with no body as before: the account takes the Chrome profile name and is not paused', async () => {
      const e = await enroll({ label: 'Office', extVersion: '0.2.0' });
      expect((await api('POST', `/api/fb-chat/devices/${e.deviceId}/approve`, { token })).status).toBe(200);
      const mine = { fbUid: '100501', label: 'Office' };
      await push('sync', sync([row('in', 'hi')], { full: true }, mine), deviceBearer(e));
      expect((await accounts()).accounts[0]).toMatchObject({ label: 'Office', paused: false });
      await push('sync', sync([row('in', 'hi')], {}, { ...mine, label: 'Office 2' }), deviceBearer(e));
      expect((await accounts()).accounts[0]!.label).toBe('Office 2');
    });

    it('marks a request from a known Facebook user as a reconnect, and moves the account to that Chrome', async () => {
      const old = await enroll({ label: 'Old laptop', extVersion: '0.2.0' });
      await post(`devices/${old.deviceId}/approve`);
      const body = sync([row('in', 'Is this still available?')], { full: true, complete: true });
      await push('sync', body, deviceBearer(old));
      await tick();
      const before = (await accounts()).accounts[0]!;
      expect(before.device).toMatchObject({ id: old.deviceId, status: 'approved' });

      const fresh = await enroll({ label: 'New desktop', extVersion: '0.3.0', fbUid: ACCOUNT.fbUid });
      const stranger = await enroll({ label: 'Someone else', extVersion: '0.3.0', fbUid: '100999' });
      const unknown = await enroll({ label: 'No user yet' });
      const listed = (await get<{ devices: FbChatDeviceRow[] }>('devices')).body.devices;
      const matchOf = (id: string) => listed.find((d) => d.id === id)!.matches_account;
      expect(matchOf(fresh.deviceId)).toEqual({ id: before.id, no: 1, label: 'Denver profile' });
      expect(matchOf(stranger.deviceId)).toBeNull();
      expect(matchOf(unknown.deviceId)).toBeNull();
      expect(await summary()).toMatchObject({ pending_devices: 3 });

      // A reconnect ignores the name and pause: the account keeps its own.
      expect((await post(`devices/${fresh.deviceId}/approve`, { label: 'Renamed', startPaused: true })).status).toBe(200);
      const after = (await accounts()).accounts;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: before.id, no: 1, label: 'Denver profile', paused: false, threads: 1,
        device: { id: fresh.deviceId, label: 'New desktop', status: 'approved' },
      });
      const devices = await getTestDb()`SELECT id, status, account_label, start_paused FROM fb_chat_devices WHERE id IN ${getTestDb()([old.deviceId, fresh.deviceId])}`;
      expect(devices.find((d) => d.id === old.deviceId)).toMatchObject({ status: 'revoked' });
      expect(devices.find((d) => d.id === fresh.deviceId)).toMatchObject({ status: 'approved', account_label: null, start_paused: false });
      expect((await push<{ error: string }>('sync', body, deviceBearer(old))).body).toEqual({ error: 'device_rejected' });
      expect((await push<FbChatSyncAnswer>('sync', body, deviceBearer(fresh))).body).toEqual({ needsFull: false, added: 0 });
      expect((await thread()).telegram_topic_id).toBe(1);
      expect((await summary()).pending_devices).toBe(2);
    });

    it('shows an account whose Chrome was disconnected, with the device it had', async () => {
      const e = await enroll({ label: 'Office', extVersion: '0.3.0' });
      await post(`devices/${e.deviceId}/approve`);
      await push('sync', sync([row('in', 'hi')], { full: true }), deviceBearer(e));
      expect((await post(`devices/${e.deviceId}/revoke`)).status).toBe(200);
      const [acct] = (await accounts()).accounts;
      expect(acct).toMatchObject({ threads: 1, device: { id: e.deviceId, status: 'revoked' } });
      expect(fbChatAccountStatus(acct!, Date.now())).toBe('stale');
      await api('DELETE', `/api/fb-chat/devices/${e.deviceId}`, { token });
      expect((await accounts()).accounts[0]!.device).toBeNull();
    });

    it('numbers accounts in the order they appear and counts what the tabs show', async () => {
      expect(await accounts()).toEqual({ accounts: [], next_no: 1, latest_ext_version: null });
      expect(await summary()).toEqual({ unread: 0, pending_devices: 0 });
      expect((await get<FbChatTelegramStatus>('telegram')).body).toEqual({ configured: true, topics: 0 });

      await seeded();
      // Every push touches the account; none of them may use up a number or an id.
      for (let i = 0; i < 5; i++) await push('outbox/claim', { account: ACCOUNT });
      await push('config', { account: ACCOUNT, extVersion: '0.2.0', fields: [FIELDS[0]] });
      await push('config', { account: OTHER, extVersion: '0.3.0', fields: FIELDS });
      await push('sync', sync([row('in', 'one'), row('out', 'two')], { full: true, complete: true }, OTHER));
      const t = await thread();
      await reply((await threads()).find((x) => x.account_no === 1)!.id, 'On my way');

      const page = await accounts();
      expect(page.next_no).toBe(3);
      expect(page.latest_ext_version).toBe('0.3.0');
      expect(page.accounts.map((a) => [a.no, a.label, a.threads, a.unread, a.replies_waiting])).toEqual([
        [1, 'Denver profile', 1, 0, 1], [2, 'Aurora profile', 1, 0, 0],
      ]);
      expect(page.accounts[1]!.id).toBe(page.accounts[0]!.id + 1);
      expect(page.accounts[0]).toMatchObject({
        fb_uid: '100042', ext_version: '0.1.0', restricted: null, paused: false, stale_after_sec: 300,
        config_state: 'up_to_date', device: null, last_sync_at: expect.any(String), config_seen_at: expect.any(String),
      });
      expect(fbChatAccountStatus(page.accounts[0]!, Date.now())).toBe('running');
      expect(fbChatAccountStatus(page.accounts[0]!, Date.now() + 301_000)).toBe('stale');
      expect(t).toBeDefined();

      // A setting it has not picked up yet; a slower settings check stretches what counts as silence.
      const put = (key: string, value: unknown, accountId: number | null = null) =>
        api('PUT', `/api/fb-chat/config/${key}`, { token, body: { accountId, value } });
      await put('paused', true, page.accounts[1]!.id);
      await put('configPollSec', 200);
      const waiting = (await accounts()).accounts;
      expect(waiting.map((a) => [a.paused, a.config_state, a.stale_after_sec])).toEqual([[false, 'waiting', 600], [true, 'waiting', 600]]);
      await push('config', { account: OTHER, extVersion: '0.3.0', fields: FIELDS });
      const caught = (await accounts()).accounts;
      expect(caught.map((a) => a.config_state)).toEqual(['waiting', 'up_to_date']);
      expect(fbChatAccountStatus(caught[1]!, Date.now())).toBe('paused');

      await push('events', { account: OTHER, kind: 'restricted', detail: { restriction: 'checkpoint' } });
      expect(fbChatAccountStatus((await accounts()).accounts[1]!, Date.now())).toBe('checkpoint');

      await push('sync', sync([row('in', 'one'), row('out', 'two'), row('in', 'three')], {}, OTHER));
      await enroll({ label: 'Waiting' });
      expect(await summary()).toEqual({ unread: 1, pending_devices: 1 });
      await tick();
      expect((await get<FbChatTelegramStatus>('telegram')).body.topics).toBeGreaterThan(0);
      expect((await api<FbChatTelegramStatus>('GET', '/api/fb-chat/telegram', { token })).body.configured).toBe(false);
      // No supergroup id, no link.
      const plain = await api<FbChatThreadsAnswer>('GET', '/api/fb-chat/threads', { token });
      expect(plain.body.threads.every((x) => x.telegram_topic_url === null)).toBe(true);
    });

    it('gives two accounts that appear at once different numbers', async () => {
      const uids = ['100601', '100602', '100603', '100604'];
      await Promise.all(uids.map((fbUid) => push('outbox/claim', { account: { fbUid, label: fbUid } })));
      await Promise.all(uids.map((fbUid) => push('outbox/claim', { account: { fbUid, label: fbUid } })));
      expect((await accounts()).accounts.map((a) => a.no)).toEqual([1, 2, 3, 4]);
    });

    it('is for managers only', async () => {
      await seeded();
      const t = await thread();
      const purchaser = (await loginAs(MARCUS)).token;
      const as = (method: string, path: string, body?: unknown) => api(method, `/api/fb-chat/${path}`, { token: purchaser, body });
      const tries = [
        as('GET', 'summary'), as('GET', 'accounts'), as('GET', 'threads'), as('GET', `threads/${t.id}/messages`),
        as('GET', 'telegram'), as('GET', 'devices'), as('GET', 'config'),
        as('POST', `threads/${t.id}/messages`, { body: 'hi' }), as('POST', `threads/${t.id}/read`), as('POST', `threads/${t.id}/unread`),
        as('POST', 'messages/1/retry', { force: true }), as('PATCH', `accounts/${t.account_id}`, { label: 'Mine' }),
        as('POST', 'devices/aaaaaaaaaaaaaaaaaa/approve', { label: 'Mine' }),
      ];
      expect((await Promise.all(tries)).map((r) => r.status)).toEqual(tries.map(() => 403));
      expect((await api('GET', '/api/fb-chat/summary')).status).toBe(401);
      expect(await getTestDb()`SELECT 1 FROM fb_chat_messages WHERE source = 'erp'`).toHaveLength(0);
      expect((await thread()).unread).toBe(true);
    });

    it('still takes exactly what extensions 0.2.0 and 0.3.0 send, and answers as before', async () => {
      // 0.2.0: a service token, an account with no version of its own on some calls.
      const old = { fbUid: '100000000000042', label: 'E2E profile' };
      const config = await push<FbChatConfigAnswer>('config', { account: old, extVersion: '0.2.0', fields: [FIELDS[0]] });
      expect(Object.keys(config.body).sort()).toEqual(['rev', 'values']);
      const window = (rows: FbChatRow[]) => ({
        account: { ...old, extVersion: '0.2.0' },
        thread: {
          fbThreadId: 'k7e601ec8e0ef7cac16',
          buyer: { name: 'Kane Bryant', profileId: null, location: null, joinedYear: null, rating: null, ratingCount: null },
          listing: { id: null, title: 'Dell R740 256GB' },
          rows, full: true, complete: true,
        },
      });
      expect((await push<FbChatSyncAnswer>('sync', window([{ direction: 'in', text: 'Is this still available?', images: [], at: 'Tuesday 5:58pm' }]))).body)
        .toEqual({ needsFull: false, added: 1 });
      expect((await push('buyer', {
        account: old, fbThreadId: 'k7e601ec8e0ef7cac16',
        buyer: { name: 'Kane Bryant', profileId: '61570000000001', location: 'Denver, Colorado', joinedYear: 2015, rating: 4.9, ratingCount: 31 },
      })).body).toEqual({ ok: true });
      expect((await push('events', { account: old, kind: 'error', detail: { where: 'composer' } })).body).toEqual({ ok: true });
      expect((await push('outbox/claim', { account: old, wait: 0 })).status).toBe(204);

      const t = (await threads())[0]!;
      await reply(t.id, 'Yes it is');
      const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: old });
      // What 0.2.0 and 0.3.0 read, plus `attempt`, which they ignore and leave out of the result.
      expect(Object.keys(claim.body).sort()).toEqual(['attempt', 'body', 'fbThreadId', 'id']);
      expect((await push(`outbox/${claim.body.id}/result`, { account: old, outcome: 'sent', typingMs: 2100 })).body).toEqual({ ok: true });

      // 0.3.0: enrolls itself, says hello, then pushes with its device bearer.
      const e = await enroll({ label: 'Buyer 1', extVersion: '0.3.0', fbUid: '100000000000043' });
      expect(Object.keys(e).sort()).toEqual(['code', 'deviceId', 'status', 'token']);
      const hello = await push<FbChatDeviceAnswer>('device', { label: 'Buyer 1', extVersion: '0.3.0', fbUid: '100000000000043' }, deviceBearer(e));
      expect(hello.body).toEqual({ deviceId: e.deviceId, code: e.code, status: 'pending' });
      await post(`devices/${e.deviceId}/approve`, {});
      const mine = { fbUid: '100000000000043', label: 'Buyer 1', extVersion: '0.3.0' };
      const cfg = await push<FbChatConfigAnswer>('config', { account: mine, extVersion: '0.3.0', fields: FIELDS }, deviceBearer(e));
      expect(cfg.body.values).toEqual({});
      expect((await push('outbox/claim', { account: mine, wait: 0 }, deviceBearer(e))).status).toBe(204);
      const status = await api('GET', '/api/fb-chat/push/status', { headers: { authorization: `Bearer ${deviceBearer(e)}` } });
      expect(status.body).toEqual({ ok: true, telegram: false });
      expect((await accounts()).accounts.map((a) => [a.no, a.label, a.device?.label ?? null])).toEqual([
        [1, 'E2E profile', null], [2, 'Buyer 1', 'Buyer 1'],
      ]);
    });
  });
});
