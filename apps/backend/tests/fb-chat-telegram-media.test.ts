import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FbChatRow, FbChatSyncPush } from '@recycle-erp/shared';
import { TelegramError, TelegramUpload, telegramCaller, telegramForm, type TelegramCall } from '../src/lib/telegramBot';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { fbChatTelegramConfig, runFbChatTelegramTick, setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

// Photos in Facebook chats reach Telegram as their stored bytes. The hub's
// other Telegram behaviour is covered by fb-chat.test.ts.

const CHAT = '-1001234567';
const ACCOUNT = { fbUid: '100042', label: 'Denver profile', extVersion: '0.1.0' };
const LINK = 'https://scontent.fbcdn.net/a.jpg';

const row = (direction: 'in' | 'out', text: string, images: string[] = []): FbChatRow => ({ direction, text, images });

function sync(rows: FbChatRow[], over: Partial<FbChatSyncPush['thread']> = {}): FbChatSyncPush {
  return {
    account: ACCOUNT,
    thread: {
      fbThreadId: 't1',
      buyer: { name: 'John Smith', profileId: '555', location: 'Aurora, Colorado' },
      listing: { id: '9988', title: 'Dell R740 256GB' },
      rows,
      full: false,
      complete: false,
      ...over,
    },
  };
}

type Call = { method: string; params: Record<string, unknown> };

describe('Facebook chat photos in Telegram', () => {
  let bearer: string;
  let calls: Call[];
  let fail: ((c: Call) => Error | null) | null;
  let topicSeq: number;

  const env = { ...testEnv, FB_CHAT_TELEGRAM_CHAT_ID: CHAT } as typeof testEnv;
  const push = (body: unknown) =>
    api('POST', '/api/fb-chat/push/sync', { body, headers: { authorization: `Bearer ${bearer}`, 'X-Requested-By': '' } });
  const tick = () => runFbChatTelegramTick(getTestDb(), fbChatTelegramConfig(env)!);

  const telegram: TelegramCall = async <T>(method: string, params: Record<string, unknown>) => {
    const call = { method, params };
    const error = fail?.(call);
    if (error) throw error;
    if (method !== 'getUpdates') calls.push(call);
    if (method === 'getUpdates') return [] as T;
    if (method === 'createForumTopic') return { message_thread_id: ++topicSeq } as T;
    return true as T;
  };

  /** What went into topics, each call as one readable line; header and topic calls left out. */
  const posts = () => calls.filter((c) => c.method !== 'createForumTopic' && !String(c.params.text ?? '').startsWith('👤 John Smith · '))
    .map((c) => {
      if (c.method === 'sendMessage') return `text ${String(c.params.text)}`;
      if (c.method === 'sendPhoto') {
        const p = c.params.photo;
        return `photo ${p instanceof TelegramUpload ? p.bytes.toString() : String(p)} | ${String(c.params.caption ?? '')}`;
      }
      const items = c.params.media as Array<{ media: TelegramUpload; caption?: string }>;
      return `album ${items.map((i) => i.media.bytes.toString()).join(',')} | ${items.map((i) => i.caption ?? '').join('|')}`;
    });

  /** Stores a photo the way the hub does where R2 is absent, and answers its id. */
  async function photo(content: string): Promise<string> {
    const [r] = await getTestDb()<{ id: string }[]>`
      INSERT INTO fb_chat_media (sha256, source, storage_key, stub_bytes, mime, bytes)
      VALUES (${`sha-${content}`}, 'facebook', ${`stub-${content}`}, ${Buffer.from(content)}, 'image/jpeg', ${content.length})
      RETURNING id::text AS id`;
    return r!.id;
  }

  /** Gives the stored message with this body its photos. */
  async function attach(body: string, contents: string[]): Promise<void> {
    const ids = [];
    for (const c of contents) ids.push(await photo(c));
    await getTestDb()`UPDATE fb_chat_messages SET media = ${getTestDb().json(ids)} WHERE body = ${body}`;
  }

  /** A thread with one buyer message, mirrored into topic 1. */
  async function seeded(): Promise<void> {
    await push(sync([row('in', 'Is this still available?')], { full: true, complete: true }));
    await tick();
    calls.length = 0;
  }

  beforeAll(async () => {
    process.env.__TEST_OAUTH_KEY__ ??= await generateSigningKey();
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
  });

  beforeEach(async () => {
    await resetDb();
    const sql = getTestDb();
    const [manager] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const client = await createOAuthClient(sql, {
      name: 'ext', redirectUris: [], grantTypes: ['client_credentials'], scopes: ['fbchat:write'], createdBy: manager!.id, public: false,
    });
    bearer = await signAccessToken({
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_OAUTH_KEY__,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as never, { clientId: client.clientId, userId: null, scopes: ['fbchat:write'] });
    calls = [];
    fail = null;
    topicSeq = 0;
    setFbChatTelegramForTests(telegram);
  });

  afterEach(() => setFbChatTelegramForTests(null));

  it('uploads one stored photo with the message as its caption', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'look', [LINK])]));
    await attach('look', ['A']);
    await tick();
    expect(posts()).toEqual(['photo A | 👤 John Smith: look']);
    expect(calls[0]!.params.message_thread_id).toBe(1);
    expect((calls[0]!.params.photo as TelegramUpload).mime).toBe('image/jpeg');
  });

  it('sends several stored photos as one album, the caption on the first', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'three', [LINK, LINK, LINK])]));
    await attach('three', ['A', 'B', 'C']);
    await tick();
    expect(posts()).toEqual(['album A,B,C | 👤 John Smith: three||']);
    expect(calls[0]!.method).toBe('sendMediaGroup');
  });

  it('leaves out a stored photo that cannot be read, and sends links when none can', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'two', [LINK, LINK]), row('in', 'gone', [LINK])]));
    await attach('two', ['A']);
    const [two] = await getTestDb()<{ media: string[] }[]>`SELECT media FROM fb_chat_messages WHERE body = 'two'`;
    const unknown = '00000000-0000-4000-8000-000000000000';
    await getTestDb()`UPDATE fb_chat_messages SET media = ${getTestDb().json([...two!.media, unknown])} WHERE body = 'two'`;
    await getTestDb()`UPDATE fb_chat_messages SET media = ${getTestDb().json([unknown])} WHERE body = 'gone'`;
    await tick();
    expect(posts()).toEqual(['photo A | 👤 John Smith: two', `photo ${LINK} | 👤 John Smith: gone`]);
  });

  it('breaks a history at each message with photos: text, album, text', async () => {
    await push(sync([row('in', 'first'), row('in', 'see these', [LINK, LINK]), row('out', 'nice'), row('in', 'ok')],
      { full: true, complete: true }));
    await attach('see these', ['A', 'B']);
    await tick();
    expect(posts()).toEqual([
      'text 📜 Earlier messages\nJohn Smith: first',
      'album A,B | John Smith: see these|',
      'text You: nice\nJohn Smith: ok',
    ]);
    calls.length = 0;
    await tick();
    expect(calls).toEqual([]);
  });

  it('resumes a history the budget cut short, without posting anything twice', async () => {
    const rows = ['a', 'p1', 'b', 'p2', 'c', 'p3', 'd'].map((t) => (t.startsWith('p') ? row('in', t, [LINK]) : row('in', t)));
    await push(sync(rows, { full: true, complete: true }));
    for (const p of ['p1', 'p2', 'p3']) await attach(p, [p.toUpperCase()]);
    // Topic and header take two of the six sends; four parts fit.
    expect((await tick()).posted).toBe(4);
    expect(posts()).toEqual([
      'text 📜 Earlier messages\nJohn Smith: a', 'photo P1 | John Smith: p1', 'text John Smith: b', 'photo P2 | John Smith: p2',
    ]);
    calls.length = 0;
    expect((await tick()).posted).toBe(3);
    expect(posts()).toEqual(['text John Smith: c', 'photo P3 | John Smith: p3', 'text John Smith: d']);
    calls.length = 0;
    await tick();
    expect(calls).toEqual([]);
  });

  it('keeps links and [photo] for messages whose photos were never stored', async () => {
    await push(sync([row('in', 'first'), row('in', 'pic', [LINK])], { full: true, complete: true }));
    await getTestDb()`UPDATE fb_chat_messages SET created_at = NOW() - INTERVAL '2 minutes'`;
    await tick();
    expect(posts()).toEqual(['text 📜 Earlier messages\nJohn Smith: first\nJohn Smith: pic [photo]']);

    calls.length = 0;
    await push(sync([row('in', 'first'), row('in', 'pic', [LINK]), row('in', 'live', [LINK])]));
    await getTestDb()`UPDATE fb_chat_messages SET created_at = NOW() - INTERVAL '2 minutes'`;
    fail = (c) => (c.method === 'sendPhoto' ? new TelegramError('Bad Request: failed to get HTTP URL content', 400, null) : null);
    await tick();
    expect(posts()).toEqual([`text 👤 John Smith: live\n${LINK}`]);
  });

  it('holds a young message whose photos are not stored yet, and what follows it', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'pic', [LINK]), row('in', 'after')]));
    await tick();
    expect(calls).toEqual([]);

    await attach('pic', ['A']);
    await tick();
    expect(posts()).toEqual(['photo A | 👤 John Smith: pic', 'text 👤 John Smith: after']);
  });

  it('posts a held message the old way once the wait is over', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'pic', [LINK]), row('in', 'after')]));
    await tick();
    expect(calls).toEqual([]);
    await getTestDb()`UPDATE fb_chat_messages SET created_at = NOW() - INTERVAL '2 minutes'`;
    await tick();
    expect(posts()).toEqual([`photo ${LINK} | 👤 John Smith: pic`, 'text 👤 John Smith: after']);
  });

  it('opens a new topic when the album finds the old one deleted', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'two', [LINK, LINK])]));
    await attach('two', ['A', 'B']);
    fail = (c) => (c.method === 'sendMediaGroup' && c.params.message_thread_id === 1
      ? new TelegramError('Bad Request: message thread not found', 400, null) : null);
    await tick();
    await tick();
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'sendMediaGroup').map((c) => c.params.message_thread_id)).toEqual([2]);
  });

  it('stops at a rate limit and posts the photo on a later tick', async () => {
    await seeded();
    await push(sync([row('in', 'Is this still available?'), row('in', 'pic', [LINK])]));
    await attach('pic', ['A']);
    fail = (c) => (c.method === 'sendPhoto' ? new TelegramError('Too Many Requests', 429, 0.001) : null);
    expect((await tick()).posted).toBe(0);
    fail = null;
    await new Promise((r) => setTimeout(r, 5));
    await tick();
    expect(posts()).toEqual(['photo A | 👤 John Smith: pic']);
  });
});

describe('telegramCaller with files', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a photo as a multipart part, and an album by attach:// names', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    const call = telegramCaller('TOKEN');
    const file = (s: string) => new TelegramUpload(Buffer.from(s), 'image/png', 'photo.png');
    await call('sendPhoto', { chat_id: CHAT, message_thread_id: 7, photo: file('A'), caption: 'hi', skipped: undefined });
    await call('sendMediaGroup', {
      chat_id: CHAT, media: [{ type: 'photo', media: file('B'), caption: 'c' }, { type: 'photo', media: file('C') }],
    });
    await call('sendMessage', { chat_id: CHAT, text: 'plain' });

    const one = seen[0]!.init.body as FormData;
    expect(one).toBeInstanceOf(FormData);
    expect(seen[0]!.init.headers).toBeUndefined();
    expect([one.get('chat_id'), one.get('message_thread_id'), one.get('caption'), one.has('skipped')]).toEqual([CHAT, '7', 'hi', false]);
    const blob = one.get('photo') as File;
    expect([blob.name, blob.type, Buffer.from(await blob.arrayBuffer()).toString()]).toEqual(['photo.png', 'image/png', 'A']);

    const album = seen[1]!.init.body as FormData;
    expect(JSON.parse(String(album.get('media')))).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'c' }, { type: 'photo', media: 'attach://file1' },
    ]);
    expect(Buffer.from(await (album.get('file1') as File).arrayBuffer()).toString()).toBe('C');

    expect(seen[2]!.init.body).toBe(JSON.stringify({ chat_id: CHAT, text: 'plain' }));
  });

  it('builds a form only from what it is given', () => {
    const form = telegramForm({ a: 1, b: { x: true }, c: null });
    expect([form.get('a'), form.get('b'), form.has('c')]).toEqual(['1', '{"x":true}', false]);
  });
});
