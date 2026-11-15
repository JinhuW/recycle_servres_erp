import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FbChatRow, FbChatSyncPush } from '@recycle-erp/shared';
import { TelegramError, TelegramUpload, telegramCaller, type TelegramCall } from '../src/lib/telegramBot';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { fbChatTelegramConfig, runFbChatTelegramTick, setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

// Photos posted in a chat's Telegram topic become replies for the extension
// to send, and photos in a reply typed in the ERP reach the topic.

const CHAT = '-1001234567';
const ACCOUNT = { fbUid: '100042', label: 'Denver profile', extVersion: '0.1.0' };
const REFUSED = 'Only text, photos, and JPEG, PNG or WebP files can be sent to Facebook. Nothing was forwarded.';

const row = (direction: 'in' | 'out', text: string): FbChatRow => ({ direction, text, images: [] });

function sync(rows: FbChatRow[]): FbChatSyncPush {
  return {
    account: ACCOUNT,
    thread: {
      fbThreadId: 't1',
      buyer: { name: 'John Smith', profileId: '555', location: 'Aurora, Colorado' },
      listing: { id: '9988', title: 'Dell R740 256GB' },
      rows,
      full: true,
      complete: true,
    },
  };
}

const jpeg = (r: number) => sharp({ create: { width: 24, height: 16, channels: 3, background: { r, g: 40, b: 90 } } }).jpeg().toBuffer();
const png = (r: number) => sharp({ create: { width: 16, height: 16, channels: 3, background: { r, g: 200, b: 10 } } }).png().toBuffer();

type Call = { method: string; params: Record<string, unknown> };
type Reply = { id: number; body: string; media: string[]; source: string; send_state: string; tg_message_id: string };

describe('Facebook chat photo replies from Telegram', () => {
  let bearer: string;
  let calls: Call[];
  let updates: unknown[];
  let files: Map<string, Buffer>;
  let fail: ((c: Call) => Error | null) | null;
  let topicSeq: number;
  let updateId: number;
  let tgMessageId: number;

  const env = { ...testEnv, FB_CHAT_TELEGRAM_CHAT_ID: CHAT } as typeof testEnv;
  const push = (body: unknown) =>
    api('POST', '/api/fb-chat/push/sync', { body, headers: { authorization: `Bearer ${bearer}`, 'X-Requested-By': '' } });
  const tick = (over: Partial<typeof env> = {}) =>
    runFbChatTelegramTick(getTestDb(), { ...fbChatTelegramConfig(env)!, env: { ...env, ...over } as typeof env });
  const sent = (method: string) => calls.filter((c) => c.method === method);
  const texts = () => sent('sendMessage').map((c) => String(c.params.text));
  const replies = () => getTestDb()<Reply[]>`
    SELECT id::int AS id, body, media, source, send_state, tg_message_id::text FROM fb_chat_messages
     WHERE direction = 'out' ORDER BY id`;
  const storedBytes = async (id: string) => {
    const [m] = await getTestDb()<{ stub_bytes: Buffer; source: string; mime: string }[]>`
      SELECT stub_bytes, source, mime FROM fb_chat_media WHERE id = ${id}`;
    return m!;
  };

  const telegram: TelegramCall = async <T>(method: string, params: Record<string, unknown>) => {
    const call = { method, params };
    const error = fail?.(call);
    if (error) throw error;
    calls.push(call);
    if (method === 'getUpdates') return updates.splice(0) as T;
    if (method === 'createForumTopic') return { message_thread_id: ++topicSeq } as T;
    if (method === 'downloadFile') {
      const bytes = files.get(String(params.file_id));
      if (!bytes) throw new TelegramError('Bad Request: invalid file_id', 400, null);
      return { bytes } as T;
    }
    return true as T;
  };

  /** A message in topic 1 from the allowed sender; answers its message id. */
  function post(message: Record<string, unknown>, from: Record<string, unknown> = {}): number {
    updates.push({
      update_id: ++updateId,
      message: {
        message_id: ++tgMessageId, message_thread_id: 1, is_topic_message: true, chat: { id: Number(CHAT) },
        from: { id: 7, is_bot: false, first_name: 'Jin', ...from }, ...message,
      },
    });
    return tgMessageId;
  }

  /** A photo in three sizes, the largest holding `bytes`. */
  function photo(name: string, bytes: Buffer): Record<string, unknown> {
    files.set(name, bytes);
    files.set(`${name}-small`, Buffer.from('thumbnail'));
    return {
      photo: [
        { file_id: `${name}-small`, width: 90, height: 60, file_size: 9 },
        { file_id: name, width: 1280, height: 853, file_size: bytes.length },
        { file_id: `${name}-small`, width: 320, height: 213, file_size: 9 },
      ],
    };
  }

  /** A thread with one buyer message, mirrored into topic 1. */
  async function seeded(): Promise<void> {
    await push(sync([row('in', 'Is this still available?')]));
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
    updates = [];
    files = new Map();
    fail = null;
    topicSeq = 0;
    updateId = 0;
    tgMessageId = 500;
    setFbChatTelegramForTests(telegram);
  });

  afterEach(() => setFbChatTelegramForTests(null));

  it('queues a photo, in its largest size, with the caption as the reply text', async () => {
    await seeded();
    const bytes = await jpeg(10);
    const id = post({ ...photo('p1', bytes), caption: '  Here it is  ' });
    expect((await tick()).queued).toBe(1);
    const [r] = await replies();
    expect(r).toMatchObject({ body: 'Here it is', source: 'telegram', send_state: 'queued', tg_message_id: String(id) });
    expect(r!.media).toHaveLength(1);
    const stored = await storedBytes(r!.media[0]!);
    expect([stored.source, stored.mime]).toEqual(['telegram', 'image/jpeg']);
    expect(sent('downloadFile').map((c) => c.params.file_id)).toEqual(['p1']);
    // Queued replies are not mirrored back into the topic, and nothing is said.
    expect(texts()).toEqual([]);
    const [mirrored] = await getTestDb()`SELECT mirrored_at FROM fb_chat_messages WHERE id = ${r!.id}`;
    expect(mirrored!.mirrored_at).not.toBeNull();
  });

  it('queues a photo without a caption with an empty body', async () => {
    await seeded();
    post(photo('p1', await jpeg(10)));
    await tick();
    expect((await replies()).map((r) => [r.body, r.media.length])).toEqual([['', 1]]);
  });

  it('queues an image sent as a file, and refuses a video and a PDF', async () => {
    await seeded();
    files.set('doc', await png(1));
    post({ document: { file_id: 'doc', mime_type: 'image/png', file_size: 100 }, caption: 'as a file' });
    const video = post({ video: { file_id: 'v' }, caption: 'a video' });
    post({ document: { file_id: 'pdf', mime_type: 'application/pdf' } });
    post({ sticker: { file_id: 's' } });
    expect((await tick()).queued).toBe(1);
    const [r] = await replies();
    expect(r!.body).toBe('as a file');
    expect((await storedBytes(r!.media[0]!)).mime).toBe('image/png');
    expect(texts()).toEqual([REFUSED, REFUSED, REFUSED]);
    expect((sent('sendMessage')[0]!.params.reply_parameters as { message_id: number }).message_id).toBe(video);
    expect(sent('downloadFile').map((c) => c.params.file_id)).toEqual(['doc']);
  });

  it('queues an album as one reply, its photos in order and the caption from whichever part has it', async () => {
    await seeded();
    const [a, b, c] = [await jpeg(1), await jpeg(2), await jpeg(3)];
    const first = post({ ...photo('a', a), media_group_id: 'g1' });
    post({ ...photo('b', b), media_group_id: 'g1', caption: 'all three' });
    post({ ...photo('c', c), media_group_id: 'g1' });
    expect((await tick()).queued).toBe(1);
    const [r, ...more] = await replies();
    expect(more).toEqual([]);
    expect(r).toMatchObject({ body: 'all three', tg_message_id: String(first) });
    expect(await Promise.all(r!.media.map(async (id) => (await storedBytes(id)).stub_bytes.length > 0))).toEqual([true, true, true]);
    // Stored in the order of the album, which the byte sizes tell apart.
    const sizes = await Promise.all(r!.media.map(async (id) => (await getTestDb()<{ sha256: string }[]>`
      SELECT sha256 FROM fb_chat_media WHERE id = ${id}`)[0]!.sha256));
    const { createHash } = await import('node:crypto');
    expect(sizes).toEqual([a, b, c].map((x) => createHash('sha256').update(x).digest('hex')));
  });

  it('keeps an album apart from a text sent between its parts, and from another sender', async () => {
    await seeded();
    post({ ...photo('a', await jpeg(1)), media_group_id: 'g1' });
    post({ text: 'between' });
    post({ ...photo('b', await jpeg(2)), media_group_id: 'g1' });
    post({ ...photo('c', await jpeg(3)), media_group_id: 'g1' }, { id: 8, first_name: 'Sam' });
    expect((await tick()).queued).toBe(3);
    expect((await replies()).map((r) => [r.body, r.media.length])).toEqual([['', 2], ['between', 0], ['', 1]]);
    const [state] = await getTestDb()<{ offset: string }[]>`SELECT "offset" FROM fb_chat_telegram_state`;
    expect(Number(state!.offset)).toBe(updateId + 1);
  });

  it('refuses an album with a part that cannot be sent, as a whole', async () => {
    await seeded();
    post({ ...photo('a', await jpeg(1)), media_group_id: 'g1', caption: 'mixed' });
    post({ video: { file_id: 'v' }, media_group_id: 'g1' });
    expect((await tick()).queued).toBe(0);
    expect(await replies()).toEqual([]);
    expect(texts()).toEqual([REFUSED]);
    expect(sent('downloadFile')).toEqual([]);
  });

  it('keeps a /-caption as a note, and skips a sender who is not allowed', async () => {
    await seeded();
    post({ ...photo('a', await jpeg(1)), caption: '/for us only' });
    post(photo('b', await jpeg(2)), { id: 99 });
    const cfg = { ...fbChatTelegramConfig(env)!, userIds: new Set(['7']) };
    expect((await runFbChatTelegramTick(getTestDb(), cfg)).queued).toBe(0);
    expect(await replies()).toEqual([]);
    expect(sent('downloadFile')).toEqual([]);
    expect(texts()).toEqual([]);
  });

  it('refuses a caption over the length limit before downloading anything', async () => {
    await seeded();
    post({ ...photo('a', await jpeg(1)), caption: 'x'.repeat(5000) });
    await tick();
    expect(await replies()).toEqual([]);
    expect(texts()[0]).toMatch(/^Too long to send/);
    expect(sent('downloadFile')).toEqual([]);
  });

  it('refuses a photo too large to take, one that does not decode, and one Telegram will not hand over', async () => {
    await seeded();
    post({ document: { file_id: 'big', mime_type: 'image/jpeg', file_size: 30 * 1024 * 1024 } });
    files.set('junk', Buffer.from('not an image at all'));
    post({ document: { file_id: 'junk', mime_type: 'image/jpeg' } });
    post({ photo: [{ file_id: 'missing', width: 10, height: 10 }] });
    expect((await tick()).queued).toBe(0);
    expect(texts()).toEqual([
      'Too large to send (the limit is 15 MB a photo). Nothing was forwarded.',
      `The image could not be read. ${REFUSED}`,
      'Telegram did not hand over the file (Bad Request: invalid file_id). Nothing was forwarded.',
    ]);
    expect(sent('downloadFile').map((c) => c.params.file_id)).toEqual(['junk', 'missing']);
  });

  it('tells the topic when photos cannot be stored, and goes on with the next reply', async () => {
    await seeded();
    post(photo('a', await jpeg(1)));
    post({ text: 'still goes' });
    // Production without a bucket: the store refuses rather than keeping a stub.
    expect((await tick({ NODE_ENV: 'production', R2_S3_ENDPOINT: undefined } as never)).queued).toBe(1);
    expect(texts()).toEqual(['Photos cannot be stored on the ERP right now. Nothing was forwarded. Send it again later.']);
    expect((await replies()).map((r) => r.body)).toEqual(['still goes']);
  });

  it('reads the update again on the next tick when the download fails on the way', async () => {
    await seeded();
    post({ text: 'before' });
    post(photo('a', await jpeg(1)));
    const batch = [...updates] as Array<{ update_id: number }>;
    fail = (c) => (c.method === 'downloadFile' ? new Error('fetch failed') : null);
    await expect(tick()).rejects.toThrow('fetch failed');
    expect((await replies()).map((r) => r.body)).toEqual(['before']);
    fail = null;
    const [state] = await getTestDb()<{ offset: string }[]>`SELECT "offset" FROM fb_chat_telegram_state`;
    expect(Number(state!.offset)).toBe(updateId);
    // A bot is handed again every update from the stored offset on.
    updates.push(...batch.filter((u) => u.update_id >= Number(state!.offset)));
    expect((await tick()).queued).toBe(1);
    expect((await replies()).map((r) => [r.body, r.media.length])).toEqual([['before', 0], ['', 1]]);
  });

  it('queues an update read twice only once, album included', async () => {
    await seeded();
    post(photo('p', await jpeg(9)));
    post({ ...photo('a', await jpeg(1)), media_group_id: 'g1' });
    post({ ...photo('b', await jpeg(2)), media_group_id: 'g1' });
    const batch = [...updates];
    expect((await tick()).queued).toBe(2);
    updates.push(...batch);
    expect((await tick()).queued).toBe(0);
    expect((await replies()).map((r) => r.media.length)).toEqual([1, 2]);
  });

  it('reacts to the first photo when the reply is sent, and answers it when it failed', async () => {
    await seeded();
    const one = post(photo('p', await jpeg(9)));
    const album = post({ ...photo('a', await jpeg(1)), media_group_id: 'g1' });
    post({ ...photo('b', await jpeg(2)), media_group_id: 'g1' });
    await tick();
    const [r1, r2] = await replies();
    await getTestDb()`UPDATE fb_chat_messages SET send_state = 'sent' WHERE id = ${r1!.id}`;
    await getTestDb()`UPDATE fb_chat_messages SET send_state = 'failed', error = 'no file input' WHERE id = ${r2!.id}`;
    calls.length = 0;
    await tick();
    expect(sent('setMessageReaction').map((c) => c.params.message_id)).toEqual([one]);
    expect(sent('sendMessage').map((c) => [c.params.text, (c.params.reply_parameters as { message_id: number }).message_id]))
      .toEqual([['❌ Not sent to Facebook: no file input. Send it again to retry.', album]]);
  });

  it('mirrors a reply typed in the ERP with its photos', async () => {
    await seeded();
    const sql = getTestDb();
    const [alex] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const [thread] = await sql<{ id: number }[]>`SELECT id::int AS id FROM fb_chat_threads`;
    const media: string[] = [];
    for (const [i, c] of ['A', 'B'].entries()) {
      const [m] = await sql<{ id: string }[]>`
        INSERT INTO fb_chat_media (sha256, source, storage_key, stub_bytes, mime, bytes)
        VALUES (${`sha-${c}`}, 'erp', ${`stub-${c}`}, ${Buffer.from(c)}, 'image/jpeg', ${i + 1})
        RETURNING id::text AS id`;
      media.push(m!.id);
    }
    await sql`
      INSERT INTO fb_chat_messages (thread_id, direction, source, body, media, send_state, erp_user_id)
      VALUES (${thread!.id}, 'out', 'erp', 'Both sides', ${sql.json(media)}, 'queued', ${alex!.id}),
             (${thread!.id}, 'out', 'erp', '', ${sql.json([media[0]!])}, 'queued', ${alex!.id})`;
    await tick();
    const album = sent('sendMediaGroup');
    expect(album).toHaveLength(1);
    const items = album[0]!.params.media as Array<{ media: TelegramUpload; caption?: string }>;
    expect(items.map((i) => [i.media.bytes.toString(), i.caption ?? ''])).toEqual([['A', '↩️ Alex (ERP): Both sides'], ['B', '']]);
    const single = sent('sendPhoto');
    expect(single.map((c) => [(c.params.photo as TelegramUpload).bytes.toString(), c.params.caption])).toEqual([['A', '↩️ Alex (ERP):']]);
  });
});

describe('telegramCaller downloadFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks getFile for the path, then fetches the file with the token', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      if (url.endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/file_1.jpg' } }));
      return new Response(Buffer.from('JPEGBYTES'));
    });
    const { bytes } = await telegramCaller('TOKEN')<{ bytes: Buffer }>('downloadFile', { file_id: 'F1' });
    expect(bytes.toString()).toBe('JPEGBYTES');
    expect(seen).toEqual(['https://api.telegram.org/botTOKEN/getFile', 'https://api.telegram.org/file/botTOKEN/photos/file_1.jpg']);
  });

  it('passes on the refusal of a file over the bot limit', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }), { status: 400 }));
    await expect(telegramCaller('TOKEN')('downloadFile', { file_id: 'F1' })).rejects.toMatchObject({ code: 400, message: 'Bad Request: file is too big' });
  });

  it('fails on a download Telegram does not serve', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/getFile')
      ? new Response(JSON.stringify({ ok: true, result: { file_path: 'x.jpg' } }))
      : new Response('gone', { status: 404 })));
    await expect(telegramCaller('TOKEN')('downloadFile', { file_id: 'F1' })).rejects.toBeInstanceOf(TelegramError);
  });
});
