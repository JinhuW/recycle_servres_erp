import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FbChatClaimAnswer, FbChatRow, FbChatSyncAnswer, FbChatSyncPush } from '@recycle-erp/shared';
import type { FbChatConfigAnswer, FbChatConfigField } from '@recycle-erp/shared';
import { chunkForTelegram, fbChatTopicName } from '../src/lib/fbChat';
import { setHoldsDraining } from '../src/lib/pgWake';
import { TelegramError, type TelegramCall } from '../src/lib/telegramBot';
import { userAccountCaller, type TelegramUserClient } from '../src/lib/telegramUser';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { compareVersions } from '../src/services/fbChatConfig';
import { fbChatTelegramConfig, fbChatTelegramConfigured, fbChatUserSession, runFbChatTelegramTick, setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
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
    let history = [{ id: 300, topicId: null, out: false, fromId: '7', text: 'old chatter in General' }];
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
      { id: 301, topicId: 41, out: true, fromId: '5', text: '👤 John Smith' },
      { id: 302, topicId: 41, out: false, fromId: '7', text: 'Yes, still available' }];
    // A new cfg reads at once rather than waiting out the catch-up interval.
    const fresh = { ...cfg, call: userAccountCaller(client, CHAT) };
    expect((await runFbChatTelegramTick(getTestDb(), fresh)).queued).toBe(1);
    const claim = await push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT });
    expect(claim.body).toMatchObject({ fbThreadId: 't1', body: 'Yes, still available' });
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
});
