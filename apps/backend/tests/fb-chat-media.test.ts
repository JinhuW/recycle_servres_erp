import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  FB_CHAT_MEDIA_MAX_UPLOAD_BYTES,
  type FbChatMediaAnswer, type FbChatMessagesAnswer, type FbChatRow, type FbChatSyncAnswer, type FbChatSyncPush,
} from '@recycle-erp/shared';
import app from '../src/index';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { fbChatMediaFetchesSettled, isFbcdnUrl, setFbChatMediaFetchForTests } from '../src/services/fbChatMediaFetch';
import { setFbChatTelegramForTests } from '../src/services/fbChatTelegram';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';

const ACCOUNT = { fbUid: '100042', label: 'Denver profile', extVersion: '0.2.0' };

const png = (r: number, g = 40, b = 200) =>
  sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g, b } } }).png().toBuffer();
const jpeg = (r: number) =>
  sharp({ create: { width: 20, height: 10, channels: 3, background: { r, g: 90, b: 10 } } }).jpeg().toBuffer();

function sync(rows: FbChatRow[], over: Partial<FbChatSyncPush['thread']> = {}): FbChatSyncPush {
  return {
    account: ACCOUNT,
    thread: {
      fbThreadId: 't1',
      buyer: { name: 'John Smith', profileId: '555', location: null, joinedYear: null, rating: null, ratingCount: null },
      listing: { id: '9988', title: 'Dell R740' },
      rows,
      full: true,
      complete: true,
      ...over,
    },
  };
}

describe('Facebook chat photos', () => {
  let bearer: string;
  let fetched: string[];
  let serve: (url: string) => Response;

  const auth = () => ({ authorization: `Bearer ${bearer}` });
  const push = <T>(path: string, body: unknown) =>
    api<T>('POST', `/api/fb-chat/push/${path}`, { body, headers: { ...auth(), 'X-Requested-By': '' } });

  async function upload(bytes: Uint8Array, type: string, headers: Record<string, string> = {}) {
    const res = await app.fetch(new Request('http://test/api/fb-chat/push/media', {
      method: 'POST', body: bytes, headers: { ...auth(), 'content-type': type, ...headers },
    }), testEnv);
    return { status: res.status, body: await res.json() as FbChatMediaAnswer & { error?: string } };
  }

  async function messages() {
    const manager = await loginAs(ALEX);
    const [thread] = await getTestDb()<{ id: number }[]>`SELECT id::int AS id FROM fb_chat_threads`;
    const res = await api<FbChatMessagesAnswer>('GET', `/api/fb-chat/threads/${thread!.id}/messages`, { token: manager.token });
    return res.body.messages;
  }

  beforeAll(async () => {
    process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
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
    fetched = [];
    serve = () => new Response(null, { status: 404 });
    setFbChatMediaFetchForTests(async (url) => {
      fetched.push(url);
      return serve(url);
    });
    setFbChatTelegramForTests(async () => true as never);
  });

  afterEach(async () => {
    await fbChatMediaFetchesSettled();
    setFbChatMediaFetchForTests(null);
    setFbChatTelegramForTests(null);
  });

  it('stores an upload once and answers the same id for the same bytes', async () => {
    const bytes = await png(10);
    const first = await upload(bytes, 'image/png');
    expect(first.status).toBe(200);
    expect(first.body.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await upload(bytes, 'image/png')).body.mediaId).toBe(first.body.mediaId);
    const rows = await getTestDb()`SELECT source, mime, width, height FROM fb_chat_media`;
    expect(rows).toEqual([{ source: 'facebook', mime: 'image/png', width: 16, height: 12 }]);
  });

  it('refuses a type it does not take, bytes that are not that type, and a body over the limit', async () => {
    expect((await upload(new TextEncoder().encode('GIF89a'), 'image/gif')).status).toBe(415);
    expect((await upload(new TextEncoder().encode('not a picture'), 'image/png')).status).toBe(415);
    expect((await upload(await jpeg(3), 'image/png')).status).toBe(415);
    expect((await upload(new Uint8Array(FB_CHAT_MEDIA_MAX_UPLOAD_BYTES + 1), 'image/jpeg')).status).toBe(413);
    // The workspace may narrow what is stored.
    await getTestDb()`
      INSERT INTO workspace_settings (key, value) VALUES ('upload_allowed_mime', ${getTestDb().json(['image/jpeg'])})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    expect((await upload(await png(11), 'image/png')).status).toBe(415);
    expect((await upload(await jpeg(4), 'image/jpeg')).status).toBe(200);
    expect(await getTestDb()`SELECT 1 FROM fb_chat_media`).toHaveLength(1);
  });

  it('needs the push credentials to upload', async () => {
    const res = await app.fetch(new Request('http://test/api/fb-chat/push/media', {
      method: 'POST', body: await png(12), headers: { 'content-type': 'image/png' },
    }), testEnv);
    expect(res.status).toBe(401);
  });

  it('keeps the ids a sync names that are stored, in order, and drops the rest', async () => {
    const a = (await upload(await png(20), 'image/png')).body.mediaId;
    const b = (await upload(await jpeg(21), 'image/jpeg')).body.mediaId;
    const unknown = '00000000-0000-4000-8000-000000000000';
    const res = await push<FbChatSyncAnswer>('sync', sync([
      { direction: 'in', text: '', images: ['https://scontent.fbcdn.net/1.jpg', 'https://scontent.fbcdn.net/2.jpg'], media: [b, unknown, a] },
      { direction: 'in', text: 'still available?', images: [], media: ['not-a-uuid'] as string[] },
      { direction: 'in', text: '', images: [], media: [a] },
    ]));
    expect(res.body).toEqual({ needsFull: false, added: 3 });
    expect((await messages()).map((m) => m.media)).toEqual([[b, a], [], [a]]);
    await fbChatMediaFetchesSettled();
    expect(fetched).toEqual([]);
  });

  it('fills the photos of a row stored before they could be uploaded when a later window lines up', async () => {
    const old = (u: string): FbChatRow => ({ direction: 'in', text: '', images: [`https://scontent.fbcdn.net/${u}.jpg`] });
    await push('sync', sync([
      { direction: 'in', text: 'hi', images: [] },
      old('a'),
      { direction: 'out', text: 'hello', images: [] },
      old('b'),
    ]));
    await fbChatMediaFetchesSettled();
    expect((await messages()).map((m) => m.media)).toEqual([[], [], [], []]);

    const a = (await upload(await png(30), 'image/png')).body.mediaId;
    const b = (await upload(await png(31), 'image/png')).body.mediaId;
    // The window starts partway into the stored tail, and runs past its end.
    const res = await push<FbChatSyncAnswer>('sync', sync([
      { ...old('a2'), media: [a] },
      { direction: 'out', text: 'hello', images: [] },
      { ...old('b2'), media: [b] },
      { direction: 'in', text: 'thanks', images: [] },
    ], { full: false }));
    expect(res.body.added).toBe(1);
    expect((await messages()).map((m) => [m.body, m.media])).toEqual([
      ['hi', []], ['', [a]], ['hello', []], ['', [b]], ['thanks', []],
    ]);

    // A photo already stored keeps its own.
    const c = (await upload(await png(32), 'image/png')).body.mediaId;
    await push('sync', sync([{ ...old('a3'), media: [c] }, { direction: 'out', text: 'hello', images: [] }, old('b3'),
      { direction: 'in', text: 'thanks', images: [] }], { full: false }));
    expect((await messages())[1]!.media).toEqual([a]);
  });

  it('fetches the photos itself for an extension that sends only links', async () => {
    const bytes = await jpeg(40);
    serve = (url) => (url.includes('/good')
      ? new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } })
      : new Response(null, { status: 403 }));
    const res = await push<FbChatSyncAnswer>('sync', sync([
      { direction: 'in', text: '', images: ['https://scontent-den2-1.xx.fbcdn.net/v/good.jpg?oh=secret', 'https://scontent.fbcdn.net/gone.jpg'] },
      { direction: 'in', text: '', images: ['https://evil.example.com/x.fbcdn.net.jpg', 'http://scontent.fbcdn.net/plain.jpg'] },
      { direction: 'in', text: 'Is this still available?', images: [] },
    ]));
    expect(res.body).toEqual({ needsFull: false, added: 3 });
    await fbChatMediaFetchesSettled();
    expect(fetched).toEqual(['https://scontent-den2-1.xx.fbcdn.net/v/good.jpg?oh=secret', 'https://scontent.fbcdn.net/gone.jpg']);
    const [stored] = await getTestDb()<{ id: string }[]>`SELECT id::text AS id FROM fb_chat_media`;
    expect((await messages()).map((m) => m.media)).toEqual([[stored!.id], [], []]);
  });

  it('follows a redirect only within the Facebook CDN', async () => {
    const bytes = await png(50);
    serve = (url) => {
      if (url.endsWith('/hop.jpg')) return new Response(null, { status: 302, headers: { location: 'https://other.fbcdn.net/final.jpg' } });
      if (url.endsWith('/away.jpg')) return new Response(null, { status: 302, headers: { location: 'https://attacker.example/final.jpg' } });
      return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    };
    await push('sync', sync([
      { direction: 'in', text: '', images: ['https://scontent.fbcdn.net/away.jpg'] },
      { direction: 'in', text: '', images: ['https://scontent.fbcdn.net/hop.jpg'] },
    ]));
    await fbChatMediaFetchesSettled();
    expect(fetched).toEqual(['https://scontent.fbcdn.net/away.jpg', 'https://scontent.fbcdn.net/hop.jpg', 'https://other.fbcdn.net/final.jpg']);
    expect((await messages()).map((m) => m.media.length)).toEqual([0, 1]);
  });

  it('refuses a fetched body over the limit even when no length is declared', async () => {
    const big = new Uint8Array(FB_CHAT_MEDIA_MAX_UPLOAD_BYTES + 10);
    serve = () => new Response(new ReadableStream({
      start(ctl) { ctl.enqueue(big.subarray(0, 8_000_000)); ctl.enqueue(big.subarray(8_000_000)); ctl.close(); },
    }), { headers: { 'content-type': 'image/jpeg' } });
    await push('sync', sync([{ direction: 'in', text: '', images: ['https://scontent.fbcdn.net/huge.jpg'] }]));
    await fbChatMediaFetchesSettled();
    expect(await getTestDb()`SELECT 1 FROM fb_chat_media`).toHaveLength(0);
  });

  it('only takes https links on a Facebook CDN host', () => {
    expect(isFbcdnUrl('https://scontent.xx.fbcdn.net/a.jpg?x=1')).toBe(true);
    expect(isFbcdnUrl('https://fbcdn.net/a.jpg')).toBe(false);
    expect(isFbcdnUrl('https://scontent.fbcdn.net.evil.com/a.jpg')).toBe(false);
    expect(isFbcdnUrl('https://scontent.fbcdn.net:8443/a.jpg')).toBe(false);
    expect(isFbcdnUrl('https://user@scontent.fbcdn.net/a.jpg')).toBe(false);
    expect(isFbcdnUrl('http://scontent.fbcdn.net/a.jpg')).toBe(false);
    expect(isFbcdnUrl('not a url')).toBe(false);
  });

  it('serves a stored photo to a manager and to no one else', async () => {
    const bytes = await png(60);
    const { mediaId } = (await upload(bytes, 'image/png')).body;
    const get = async (id: string, token?: string) => app.fetch(new Request(`http://test/api/fb-chat/media/${id}`, {
      headers: token ? { cookie: `at=${token}` } : {},
    }), testEnv);

    const manager = await loginAs(ALEX);
    const res = await get(mediaId, manager.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

    expect((await get(mediaId)).status).toBe(401);
    expect((await get(mediaId, (await loginAs(MARCUS)).token)).status).toBe(403);
    expect((await get('00000000-0000-4000-8000-000000000000', manager.token)).status).toBe(404);
    expect((await get('nope', manager.token)).status).toBe(404);
  });
});
