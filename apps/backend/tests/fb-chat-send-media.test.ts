import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type {
  FbChatClaimAnswer, FbChatMediaAnswer, FbChatReplyAnswer, FbChatRow, FbChatSyncAnswer, FbChatSyncPush,
} from '@recycle-erp/shared';
import app from '../src/index';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { alignWindow, findReply, type PendingReply } from '../src/services/fbChat';
import { fbChatMediaFetchesSettled, setFbChatMediaFetchForTests } from '../src/services/fbChatMediaFetch';
import { setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

const ACCOUNT = { fbUid: '100042', label: 'Denver profile', extVersion: '0.5.0' };
const PIC = 'https://scontent.fbcdn.net/sent.jpg';

const png = (r: number) =>
  sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g: 40, b: 200 } } }).png().toBuffer();
const jpeg = (r: number) =>
  sharp({ create: { width: 20, height: 10, channels: 3, background: { r, g: 90, b: 10 } } }).jpeg().toBuffer();

const row = (direction: 'in' | 'out', text: string, images: string[] = []): FbChatRow => ({ direction, text, images });
const photo = (text = ''): FbChatRow => row('out', text, [PIC]);

function sync(rows: FbChatRow[], fbThreadId = 't1'): FbChatSyncPush {
  return {
    account: ACCOUNT,
    thread: {
      fbThreadId,
      buyer: { name: 'John Smith', profileId: '555', location: null, joinedYear: null, rating: null, ratingCount: null },
      listing: { id: '9988', title: 'Dell R740' },
      rows,
      full: true,
      complete: true,
    },
  };
}

describe('alignWindow with photo replies', () => {
  const m = (direction: string, body: string, extra: { split?: boolean; photo?: boolean } = {}) => ({ direction, body, ...extra });

  it('lays a captioned photo reply over one bubble or two, in either order', () => {
    const stored = [m('in', 'hi'), m('out', 'Here it is', { split: true })];
    expect(alignWindow(stored, [m('in', 'hi'), m('out', 'Here it is', { photo: true })])).toBe(2);
    expect(alignWindow(stored, [m('in', 'hi'), m('out', '', { photo: true }), m('out', 'Here it is'), m('in', 'thanks')])).toBe(3);
    expect(alignWindow(stored, [m('in', 'hi'), m('out', 'Here it is'), m('out', '', { photo: true }), m('in', 'thanks')])).toBe(3);
    // The window may begin between the two bubbles.
    expect(alignWindow(stored, [m('out', 'Here it is'), m('in', 'thanks')])).toBe(1);
    expect(alignWindow([...stored, m('in', 'thanks')], [m('out', '', { photo: true }), m('in', 'thanks')])).toBe(2);
    // A reply without photos never covers two bubbles.
    expect(alignWindow([m('in', 'hi'), m('out', 'Here it is')], [m('in', 'hi'), m('out', '', { photo: true }), m('out', 'Here it is')])).toBe(0);
  });
});

describe('findReply', () => {
  const pending = (body: string, media: number, id = 1): PendingReply => ({ id, body, send_state: 'sending', media });

  it('never matches on empty text', () => {
    expect(findReply([pending('', 0)], [row('out', 'anything at all')], 0)).toBeNull();
    expect(findReply([pending('', 2)], [row('out', 'anything at all')], 0)).toBeNull();
    expect(findReply([pending('Sure', 0)], [photo()], 0)).toBeNull();
  });

  it('prefers the reply whose caption is beside the photo', () => {
    const replies = [pending('', 1, 1), pending('the other one', 1, 2), pending('This one', 1, 3)];
    expect(findReply(replies, [photo(), row('out', 'This one')], 0)).toEqual({ index: 2, rows: 2 });
    expect(findReply(replies, [photo()], 0)).toEqual({ index: 0, rows: 1 });
    expect(findReply(replies, [row('out', 'This one'), photo()], 0)).toEqual({ index: 2, rows: 2 });
  });
});

describe('Facebook chat photo replies', () => {
  let bearer: string;
  let otherBearer: string;
  let manager: string;

  const auth = (token = bearer) => ({ authorization: `Bearer ${token}`, 'X-Requested-By': '' });
  const push = <T>(path: string, body: unknown, token = bearer) =>
    api<T>('POST', `/api/fb-chat/push/${path}`, { body, headers: auth(token) });
  const claim = (caps?: string[]) => push<FbChatClaimAnswer>('outbox/claim', { account: ACCOUNT, ...(caps ? { caps } : {}) });
  const report = (id: number, outcome: 'sent' | 'failed') => push(`outbox/${id}/result`, { account: ACCOUNT, outcome });
  const reply = (threadId: number, body: Record<string, unknown>) =>
    api<FbChatReplyAnswer & { error?: string }>('POST', `/api/fb-chat/threads/${threadId}/messages`, { token: manager, body });

  async function upload(bytes: Uint8Array, headers: Record<string, string>, type = 'image/png') {
    const res = await app.fetch(new Request('http://test/api/fb-chat/media', {
      method: 'POST', body: bytes, headers: { 'content-type': type, ...headers },
    }), testEnv);
    return { status: res.status, body: await res.json() as FbChatMediaAnswer & { error?: string } };
  }
  const asManager = (token = manager) => ({ cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' });
  const uploaded = async (bytes: Uint8Array, type = 'image/png') => (await upload(bytes, asManager(), type)).body.mediaId;

  async function download(id: string, token = bearer) {
    const res = await app.fetch(new Request(`http://test/api/fb-chat/push/media/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    }), testEnv);
    return res;
  }

  async function threadId(fbThreadId = 't1') {
    const [t] = await getTestDb()<{ id: number }[]>`SELECT id::int AS id FROM fb_chat_threads WHERE fb_thread_id = ${fbThreadId}`;
    return t!.id;
  }
  async function stateOf(id: number) {
    const [m] = await getTestDb()<{ send_state: string; seq: number | null; media: string[] }[]>`
      SELECT send_state, seq, media FROM fb_chat_messages WHERE id = ${id}`;
    return m!;
  }
  const bodies = async () => (await getTestDb()<{ direction: string; source: string; body: string; seq: number }[]>`
    SELECT direction, source, body, seq FROM fb_chat_messages WHERE seq IS NOT NULL ORDER BY seq`)
    .map((m) => [m.seq, m.direction, m.source, m.body]);

  beforeAll(async () => {
    process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
  });

  beforeEach(async () => {
    await resetDb();
    const sql = getTestDb();
    const [alex] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const mint = async (name: string) => {
      const client = await createOAuthClient(sql, {
        name, redirectUris: [], grantTypes: ['client_credentials'], scopes: ['fbchat:write'], createdBy: alex!.id, public: false,
      });
      return signAccessToken({
        OAUTH_ISSUER_URL: 'http://localhost:8787',
        OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_OAUTH_KEY__,
        OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
      } as never, { clientId: client.clientId, userId: null, scopes: ['fbchat:write'] });
    };
    bearer = await mint('ext');
    otherBearer = await mint('other ext');
    manager = (await loginAs(ALEX)).token;
    setFbChatMediaFetchForTests(async () => new Response(null, { status: 404 }));
    setFbChatTelegramForTests(async () => true as never);
    expect((await push<FbChatSyncAnswer>('sync', sync([row('in', 'Can I see a photo?')]))).body.added).toBe(1);
  });

  afterEach(async () => {
    await fbChatMediaFetchesSettled();
    setFbChatMediaFetchForTests(null);
    setFbChatTelegramForTests(null);
  });

  describe('uploading from the page', () => {
    it('stores a photo for a manager, with the CSRF header', async () => {
      const res = await upload(await png(1), asManager());
      expect(res.status).toBe(200);
      expect(res.body.mediaId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await getTestDb()`SELECT source, mime FROM fb_chat_media`).toEqual([{ source: 'erp', mime: 'image/png' }]);
    });

    it('refuses without the CSRF header, a non-manager, no session, and what is not a photo', async () => {
      expect((await upload(await png(2), { cookie: `at=${manager}` })).status).toBe(403);
      const purchaser = (await loginAs(MARCUS)).token;
      expect((await upload(await png(2), asManager(purchaser))).status).toBe(403);
      expect((await upload(await png(2), { 'X-Requested-By': 'recycle-erp' })).status).toBe(401);
      expect((await upload(new TextEncoder().encode('GIF89a'), asManager(), 'image/gif')).status).toBe(415);
      expect((await upload(new TextEncoder().encode('not a picture'), asManager())).status).toBe(415);
      expect(await getTestDb()`SELECT 1 FROM fb_chat_media`).toEqual([]);
    });
  });

  describe('queueing a reply with photos', () => {
    it('takes photos alone or with text, keeps their order, and keeps them through a retry', async () => {
      const t = await threadId();
      const a = await uploaded(await png(10));
      const b = await uploaded(await jpeg(11), 'image/jpeg');

      const alone = await reply(t, { body: '', media: [b, a] });
      expect(alone.status).toBe(201);
      expect(alone.body.message).toMatchObject({ body: '', media: [b, a], send_state: 'queued', source: 'erp' });

      const key = crypto.randomUUID();
      const captioned = await reply(t, { body: ' Here it is ', media: [a.toUpperCase()], clientKey: key });
      expect(captioned.status).toBe(201);
      expect(captioned.body.message).toMatchObject({ body: 'Here it is', media: [a] });
      // The same reply again is the one already queued.
      const again = await reply(t, { body: 'Here it is', media: [a], clientKey: key });
      expect(again.status).toBe(200);
      expect(again.body.message.id).toBe(captioned.body.message.id);

      const first = await claim(['media']);
      expect(first.body.id).toBe(alone.body.message.id);
      await report(first.body.id, 'failed');
      const retried = await api<FbChatReplyAnswer>('POST', `/api/fb-chat/messages/${first.body.id}/retry`, { token: manager });
      expect(retried.status).toBe(200);
      expect(retried.body.message).toMatchObject({ send_state: 'queued', media: [b, a] });
    });

    it('refuses photo ids that are malformed, unknown, too many, or not a list', async () => {
      const t = await threadId();
      const a = await uploaded(await png(12));
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect((await reply(t, { body: 'x', media: ['not-a-uuid'] })).status).toBe(400);
      expect((await reply(t, { body: '', media: [a, unknown] })).status).toBe(400);
      expect((await reply(t, { body: 'x', media: a })).status).toBe(400);
      const eleven = Array.from({ length: 11 }, () => crypto.randomUUID());
      expect((await reply(t, { body: 'x', media: eleven })).status).toBe(400);
      expect((await reply(t, { body: '', media: [] })).status).toBe(400);
      expect((await reply(t, { media: [a] })).status).toBe(201);
      expect(await getTestDb()`SELECT 1 FROM fb_chat_messages WHERE direction = 'out'`).toHaveLength(1);
    });
  });

  describe('claiming', () => {
    it('gives a photo reply only to an extension that can attach it, and holds what follows in that chat', async () => {
      await push('sync', sync([row('in', 'Another chat')], 't2'));
      const t1 = await threadId('t1');
      const t2 = await threadId('t2');
      const a = await uploaded(await png(20));
      const b = await uploaded(await jpeg(21), 'image/jpeg');
      const pics = (await reply(t1, { body: 'Both sides', media: [b, a] })).body.message.id;
      const after = (await reply(t1, { body: 'Price is $40' })).body.message.id;
      const elsewhere = (await reply(t2, { body: 'Yes, still here' })).body.message.id;

      // An old extension skips the photos, and the reply after them in t1, but serves t2.
      const old = await claim();
      expect(old.body).toEqual({ id: elsewhere, fbThreadId: 't2', body: 'Yes, still here', attempt: 1 });
      await report(old.body.id, 'sent');
      expect((await claim(['unknown-cap'])).status).toBe(204);

      const meta = await getTestDb()<{ id: string; mime: string; bytes: number }[]>`
        SELECT id::text AS id, mime, bytes FROM fb_chat_media`;
      const byId = new Map(meta.map((m) => [m.id, m]));
      const withPhotos = await claim(['media', 'later']);
      expect(withPhotos.body).toEqual({
        id: pics, fbThreadId: 't1', body: 'Both sides', attempt: 1, media: [byId.get(b), byId.get(a)],
      });
      await report(pics, 'sent');
      // Now the text behind it may go, even to the old extension.
      const next = await claim();
      expect(next.body).toEqual({ id: after, fbThreadId: 't1', body: 'Price is $40', attempt: 1 });
    });
  });

  describe('downloading a photo to send', () => {
    it('serves a photo of a reply still going out on its own account, and nothing else', async () => {
      const t = await threadId();
      const bytes = await png(30);
      const a = await uploaded(bytes);
      // A buyer's photo, as the extension stores it from the page.
      const buyerRes = await app.fetch(new Request('http://test/api/fb-chat/push/media', {
        method: 'POST', body: await jpeg(31), headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/jpeg' },
      }), testEnv);
      const buyerPhoto = (await buyerRes.json() as FbChatMediaAnswer).mediaId;
      await push('sync', sync([row('in', 'Can I see a photo?'), { direction: 'in', text: '', images: [PIC], media: [buyerPhoto] }]));

      const id = (await reply(t, { body: '', media: [a] })).body.message.id;
      const queued = await download(a);
      expect(queued.status).toBe(200);
      expect(queued.headers.get('content-type')).toBe('image/png');
      expect(queued.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await queued.arrayBuffer()).equals(bytes)).toBe(true);
      expect((await download(a.toUpperCase())).status).toBe(200);

      expect((await download(buyerPhoto)).status).toBe(404);
      expect((await download('00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await download('nope')).status).toBe(404);
      // Another extension, relaying no account with this reply.
      expect((await download(a, otherBearer)).status).toBe(404);
      expect((await download(a, 'nonsense')).status).toBe(401);

      const claimed = await claim(['media']);
      expect((await download(a)).status).toBe(200);
      await report(claimed.body.id, 'sent');
      expect((await stateOf(id)).send_state).toBe('sent');
      expect((await download(a)).status).toBe(404);
    });
  });

  describe('finding a sent photo reply in the conversation', () => {
    async function sending(body: string, media: number) {
      const t = await threadId();
      const ids = [];
      for (let i = 0; i < media; i++) ids.push(await uploaded(await png(40 + i)));
      const id = (await reply(t, { body, media: ids })).body.message.id;
      expect((await claim(['media'])).body.id).toBe(id);
      return id;
    }
    const resync = async (rows: FbChatRow[]) => (await push<FbChatSyncAnswer>('sync', sync([row('in', 'Can I see a photo?'), ...rows]))).body.added;

    it('matches a photo-only reply by the photo', async () => {
      const id = await sending('', 1);
      expect(await resync([photo()])).toBe(0);
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2 });
      expect(await resync([photo(), row('in', 'Nice')])).toBe(1);
      expect(await bodies()).toEqual([[1, 'in', 'facebook', 'Can I see a photo?'], [2, 'out', 'erp', ''], [3, 'in', 'facebook', 'Nice']]);
    });

    it('matches a photo with its caption in the same bubble', async () => {
      const id = await sending('Here it is', 2);
      expect(await resync([photo('Here it is')])).toBe(0);
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2 });
      expect(await resync([photo('Here it is'), row('in', 'Nice')])).toBe(1);
    });

    for (const order of ['photo first', 'caption first'] as const) {
      it(`takes a caption shown as its own bubble as part of the reply, ${order}`, async () => {
        const id = await sending('Here it is', 1);
        const pair = order === 'photo first' ? [photo(), row('out', 'Here it is')] : [row('out', 'Here it is'), photo()];
        expect(await resync(pair)).toBe(0);
        expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2 });
        const [t] = await getTestDb()<{ last_seq: number }[]>`SELECT last_seq FROM fb_chat_threads`;
        expect(t!.last_seq).toBe(3);
        // Later windows line up across both bubbles.
        expect(await resync(pair)).toBe(0);
        expect(await resync([...pair, row('in', 'Nice')])).toBe(1);
        expect(await bodies()).toEqual([
          [1, 'in', 'facebook', 'Can I see a photo?'], [2, 'out', 'erp', 'Here it is'], [4, 'in', 'facebook', 'Nice'],
        ]);
      });
    }

    it('lines up two caption bubbles for a reply the extension reported first', async () => {
      const id = await sending('Here it is', 1);
      await report(id, 'sent');
      expect(await stateOf(id)).toMatchObject({ send_state: 'sent', seq: 2 });
      expect(await resync([photo(), row('out', 'Here it is'), row('in', 'Nice')])).toBe(1);
      expect(await bodies()).toEqual([
        [1, 'in', 'facebook', 'Can I see a photo?'], [2, 'out', 'erp', 'Here it is'], [3, 'in', 'facebook', 'Nice'],
      ]);
    });

    it('does not take a photo bubble for a text reply, or a text bubble for a photo-only reply', async () => {
      const t = await threadId();
      const text = (await reply(t, { body: 'Sure thing' })).body.message.id;
      expect((await claim()).body.id).toBe(text);
      expect(await resync([photo()])).toBe(1);
      expect((await stateOf(text)).send_state).toBe('sending');
      expect(await resync([photo(), row('out', 'Sure thing')])).toBe(0);
      expect((await stateOf(text)).send_state).toBe('sent');

      const pic = await sending('', 1);
      expect(await resync([photo(), row('out', 'Sure thing'), row('out', 'typed on the phone')])).toBe(1);
      expect((await stateOf(pic)).send_state).toBe('sending');
    });
  });
});
