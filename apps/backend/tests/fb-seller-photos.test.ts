import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FbAd, FbPhoto, FbPhotoPool, FbPlacement } from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import {
  hoursAround, managerCount, notificationCount, patchSettings, png, seedAd, seedPool, seedSlot,
} from './helpers/fbSeller';
import { pickPhotos, placeAd, sniffImage } from '../src/services/fbAds';
import { runFbSellerTick } from '../src/services/fbPacing';

vi.mock('../src/fleet/seller', async () => ({ enqueueSellerTask: (await import('./helpers/fbSeller')).fakeEnqueueSellerTask }));

beforeEach(async () => { await resetDb(); });

type Refusal = { error: string; detail: string };
type Upload = { added: FbPhoto[]; refused: { name: string; reason: string }[] };
const file = (bytes: Uint8Array, name: string, type = 'image/png') => new File([bytes], name, { type });

async function alexId(): Promise<string> {
  const [u] = await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
  return u!.id;
}

describe('photo pools', () => {
  it('uploads many at once, hashes server-side, and refuses duplicates and non-images by name', async () => {
    const m = await loginAs(ALEX);
    const a = await api<FbPhotoPool>('POST', '/api/fb-seller/pools', { cookies: m.cookies, body: { name: 'RAM sticks' } });
    const b = await api<FbPhotoPool>('POST', '/api/fb-seller/pools', { cookies: m.cookies, body: { name: 'Drives' } });
    expect(a.status).toBe(200);
    const again = await api<Refusal>('POST', '/api/fb-seller/pools', { cookies: m.cookies, body: { name: 'ram sticks' } });
    expect(again.status).toBe(409);
    expect(again.body.detail).toMatch(/already exists/);

    const one = png('one');
    const two = png('two');
    // multipart() sets one value per key, so build the form by hand for several "file" fields.
    const form = new FormData();
    form.append('file', file(one, 'one.png'));
    form.append('file', file(two, 'two.png'));
    form.append('file', file(one, 'one-again.png'));
    form.append('file', file(new TextEncoder().encode('<svg/>'), 'evil.png'));
    const res = await (await import('../src/index')).default.fetch(
      new Request(`http://test/api/fb-seller/pools/${a.body.id}/photos`, {
        method: 'POST', body: form, headers: { 'X-Requested-By': 'recycle-erp', Cookie: Object.entries(m.cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
      }),
      (await import('./helpers/app')).testEnv,
    );
    const up = await res.json() as Upload;
    expect(res.status).toBe(200);
    expect(up.added.map((p) => p.width)).toEqual([4, 4]);
    expect(up.added[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(up.refused).toEqual([
      { name: 'one-again.png', reason: 'It is the same photo as "one.png" in this upload.' },
      { name: 'evil.png', reason: 'It is not a PNG, JPEG or WebP image.' },
    ]);

    // The same file in another pool is refused, naming the pool and photo it duplicates.
    const dup = await multipart(`/api/fb-seller/pools/${b.body.id}/photos`, { file: file(one, 'copy.png') }, { cookies: m.cookies });
    expect((dup.body as Upload).refused).toEqual([
      { name: 'copy.png', reason: `The same photo is already in pool "RAM sticks" as photo #${up.added[0]!.id}.` },
    ]);

    const pools = await api<{ rows: FbPhotoPool[] }>('GET', '/api/fb-seller/pools', { cookies: m.cookies });
    expect(pools.body.rows.find((p) => p.id === a.body.id)).toMatchObject({ used: 0, unused: 2 });
  });

  it('deletes only an unused photo', async () => {
    const m = await loginAs(ALEX);
    const { photoIds } = await seedPool('p', 2);
    await getTestDb()`UPDATE fb_photos SET used_at = NOW() WHERE id = ${photoIds[0]!}`;
    const used = await api<Refusal>('DELETE', `/api/fb-seller/photos/${photoIds[0]}`, { cookies: m.cookies });
    expect(used.status).toBe(409);
    expect(used.body.error).toBe('photo_used');
    expect((await api('DELETE', `/api/fb-seller/photos/${photoIds[1]}`, { cookies: m.cookies })).status).toBe(200);
  });

  it('reads JPEG and WebP sizes from their headers', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 40, height: 30 });
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', width: 100, height: 50 });
  });
});

describe('placing an ad', () => {
  it('draws random unused photos and never draws one twice', async () => {
    const acc = await seedSlot();
    const { poolId, photoIds } = await seedPool('p', 12);
    const ad = await seedAd(poolId, { min: 2, max: 3 });
    const user = await alexId();
    const seen: number[] = [];
    for (const loc of ['Denver, CO', 'Boulder, CO', 'Aurora, CO', 'Golden, CO']) {
      const { placements } = await getTestDb().begin((tx) => placeAd(tx, ad, { account_nos: [acc], locations: [loc] }, user));
      expect(placements[0]!.state).toBe('queued');
      expect(placements[0]!.photo_ids.length).toBeGreaterThanOrEqual(2);
      seen.push(...placements[0]!.photo_ids);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.every((id) => photoIds.includes(id))).toBe(true);
    const marked = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fb_photos WHERE used_at IS NOT NULL AND used_by_placement IS NOT NULL`;
    expect(marked[0]!.n).toBe(seen.length);
  });

  it('two placements racing for the last photos split them and share none', async () => {
    const acc = await seedSlot();
    const { poolId } = await seedPool('p', 4);
    const ad = await seedAd(poolId, { min: 3, max: 3 });
    const db = getTestDb();
    const [p1, p2] = await Promise.all([1, 2].map(async () => (await db<{ id: number }[]>`
      INSERT INTO fb_ad_placements (ad_id, account_no, location, content, state)
      VALUES (${ad}, ${acc}, 'Denver, CO', '{}', 'needs_photos') RETURNING id::int AS id`)[0]!.id));
    const shape = { photo_pool_id: poolId, photos_min: 3, photos_max: 3 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let firstPicked!: () => void;
    const picked = new Promise<void>((r) => { firstPicked = r; });
    const first = db.begin(async (tx) => {
      const r = await pickPhotos(tx, p1!, shape);
      firstPicked();
      await gate;   // hold the row locks while the second one picks
      return r;
    });
    await picked;
    const second = await db.begin((tx) => pickPhotos(tx, p2!, shape));
    release();
    const a = await first;
    expect(a).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, short: 2 });
    const used = await db<{ id: number; by: number }[]>`SELECT id::int AS id, used_by_placement::int AS by FROM fb_photos WHERE used_at IS NOT NULL`;
    expect(used.every((u) => u.by === p1)).toBe(true);
    expect(used).toHaveLength(3);
  });

  it('short of photos the placement waits as needs_photos, and managers hear once', async () => {
    const m = await loginAs(ALEX);
    const a1 = await seedSlot();
    const a2 = await seedSlot();
    const { poolId } = await seedPool('Thin pool', 1);
    const ad = await seedAd(poolId, { min: 2, max: 2 });
    const r = await api<{ placements: FbPlacement[]; refused: unknown[] }>('POST', `/api/fb-seller/ads/${ad}/place`, {
      cookies: m.cookies, body: { account_nos: [a1, a2], locations: ['Denver, CO'] },
    });
    expect(r.status).toBe(200);
    expect(r.body.placements.map((p) => p.state)).toEqual(['needs_photos', 'needs_photos']);
    expect(await notificationCount('fb_seller_needs_photos')).toBe(await managerCount());
    const [n] = await getTestDb()<{ body: string }[]>`SELECT body FROM notifications WHERE kind = 'fb_seller_needs_photos' LIMIT 1`;
    expect(n!.body).toMatch(/needs 1 more unused photo in pool "Thin pool"/);
    const unused = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fb_photos WHERE used_at IS NULL`;
    expect(unused[0]!.n).toBe(1);
  });

  it('refuses with the reason when the ad is not ready, the account is not a seller, or the day\'s limit is reached', async () => {
    const m = await loginAs(ALEX);
    const seller = await seedSlot();
    const searcher = await seedSlot({ role: 'search' });
    const { poolId } = await seedPool('p', 10);
    const draft = await seedAd(poolId, { state: 'draft' });
    const ad = await seedAd(poolId);
    const d = await api<{ refused: { reason: string }[] }>('POST', `/api/fb-seller/ads/${draft}/place`, {
      cookies: m.cookies, body: { account_nos: [seller], locations: ['Denver, CO'] },
    });
    expect(d.body.refused[0]!.reason).toBe('The ad is draft, not ready to post.');
    const r = await api<{ placements: FbPlacement[]; refused: { account_no: number; reason: string }[] }>('POST', `/api/fb-seller/ads/${ad}/place`, {
      cookies: m.cookies, body: { account_nos: [seller, searcher], locations: ['Denver, CO'] },
    });
    expect(r.body.placements).toHaveLength(1);
    expect(r.body.refused).toEqual([{ account_no: searcher, location: 'Denver, CO', reason: `Account ${searcher} is not a seller account.` }]);
    const again = await api<{ placements: FbPlacement[]; refused: { reason: string }[] }>('POST', `/api/fb-seller/ads/${ad}/place`, {
      cookies: m.cookies, body: { account_nos: [seller], locations: ['denver,  co'] },
    });
    expect(again.body.placements).toHaveLength(0);
    expect(again.body.refused[0]!.reason).toMatch(/already went up in denver, co 1 time today; the limit is 1 a day/);
  });

  it('an ad needs a pool before it is ready, and renewal draws fresh photos', async () => {
    const m = await loginAs(ALEX);
    const created = await api<FbAd>('POST', '/api/fb-seller/ads', {
      cookies: m.cookies, body: { title: 'We buy SSDs', description: 'Enterprise SAS and NVMe drives, any quantity.', price_usd: 1, photo_pool_id: null },
    });
    expect(created.body).toMatchObject({ state: 'draft', renew_days: 7, photos_min: 3, photos_max: 5 });
    const noPool = await api<Refusal>('PATCH', `/api/fb-seller/ads/${created.body.id}`, { cookies: m.cookies, body: { state: 'ready' } });
    expect(noPool.status).toBe(422);
    expect(noPool.body.detail).toMatch(/needs a photo pool/);

    const acc = await seedSlot();
    const { poolId } = await seedPool('p', 10);
    const ready = await api<FbAd>('PATCH', `/api/fb-seller/ads/${created.body.id}`, {
      cookies: m.cookies, body: { state: 'ready', photo_pool_id: poolId, photos_min: 2, photos_max: 2 },
    });
    expect(ready.body.state).toBe('ready');
    const placed = await api<{ placements: FbPlacement[] }>('POST', `/api/fb-seller/ads/${created.body.id}/place`, {
      cookies: m.cookies, body: { account_nos: [acc], locations: ['Denver, CO'] },
    });
    const first = placed.body.placements[0]!;
    await getTestDb()`UPDATE fb_ad_placements SET state = 'live', fb_listing_id = '1234567890', posted_at = NOW() WHERE id = ${first.id}`;
    const renewed = await api<FbPlacement>('POST', `/api/fb-seller/placements/${first.id}/renew`, { cookies: m.cookies });
    expect(renewed.status).toBe(200);
    expect(renewed.body).toMatchObject({ renews_id: first.id, state: 'queued', location: 'Denver, CO' });
    expect(renewed.body.photo_ids.some((id) => first.photo_ids.includes(id))).toBe(false);
    const old = await api<FbAd>('GET', `/api/fb-seller/ads/${created.body.id}`, { cookies: m.cookies });
    expect(old.body.placements!.find((p) => p.id === first.id)!.state).toBe('removing');
  });
});

describe('the low-pool alert', () => {
  it('fires once per pool while it stays low, and again after a refill runs low', async () => {
    const now = new Date();
    await patchSettings((s) => { s.active_hours = hoursAround(now); s.photos.low_pool_warning = 5; });
    const { poolId } = await seedPool('Low', 2);
    await seedAd(poolId);
    await runFbSellerTick(getTestDb(), { now });
    await runFbSellerTick(getTestDb(), { now });
    const kind = `fb_seller_low_pool:${poolId}`;
    expect(await notificationCount(kind)).toBe(await managerCount());
    // A new upload re-arms it; the pool is still under the warning, so it fires once more.
    await getTestDb()`INSERT INTO fb_photos (pool_id, r2_key, mime, bytes, sha256, uploaded_at)
                      VALUES (${poolId}, 'stub-x', 'image/png', 1, 'refill', NOW() + interval '1 second')`;
    await new Promise((r) => setTimeout(r, 1100));
    await runFbSellerTick(getTestDb(), { now });
    await runFbSellerTick(getTestDb(), { now });
    expect(await notificationCount(kind)).toBe(2 * await managerCount());
  });
});
