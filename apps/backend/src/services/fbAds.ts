import { createHash } from 'node:crypto';
import type {
  FbAd, FbAdInput, FbAdState, FbPhoto, FbPhotoPool, FbPlacement, FbPlacementContent,
} from '@recycle-erp/shared';
import { FB_AD_STATES } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { alertManagers } from '../lib/fbSellerAlert';
import type { Env } from '../types';
import { loadFbSellerSettings } from './fbConfig';

// Photo pools, ads and placements (CONTRACTS §5.1). A photo is used once,
// ever: the pick sets used_at under FOR UPDATE SKIP LOCKED inside the
// placement's own transaction, so two placements racing for a pool's last
// photos split them and never share one.

/** A refusal a route answers with `{ error, detail }`. */
export class FbSellerRefusal extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422, public readonly error: string, detail: string) {
    super(detail);
    this.name = 'FbSellerRefusal';
  }
}

const refuse = (status: 400 | 404 | 409 | 422, error: string, detail: string): never => {
  throw new FbSellerRefusal(status, error, detail);
};

/** Dates to ISO strings, the way the DTOs carry every instant. */
export function plain<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out as T;
}

export function photoUrl(env: Env, key: string): string {
  const base = env.R2_ATTACHMENTS_PUBLIC_URL?.replace(/\/$/, '');
  return base ? `${base}/${key}` : key;
}

// ─── Pools and photos ─────────────────────────────────────────────────────────

const POOL_COLS = (sql: SqlLike) => sql`
  p.id::int AS id, p.name, p.note, p.created_by, p.created_at, p.archived_at,
  (SELECT COUNT(*)::int FROM fb_photos f WHERE f.pool_id = p.id AND f.used_at IS NOT NULL) AS used,
  (SELECT COUNT(*)::int FROM fb_photos f WHERE f.pool_id = p.id AND f.used_at IS NULL) AS unused`;

export async function listPools(sql: SqlLike): Promise<FbPhotoPool[]> {
  const rows = await sql`SELECT ${POOL_COLS(sql)} FROM fb_photo_pools p ORDER BY p.archived_at IS NOT NULL, p.name`;
  return rows.map((r) => plain<FbPhotoPool>(r));
}

export async function getPool(sql: SqlLike, id: number): Promise<FbPhotoPool> {
  const [r] = await sql`SELECT ${POOL_COLS(sql)} FROM fb_photo_pools p WHERE p.id = ${id}`;
  return r ? plain<FbPhotoPool>(r) : refuse(404, 'not_found', 'There is no such photo pool.');
}

function poolName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return refuse(422, 'bad_pool', 'name: give the pool a name.');
  const name = raw.trim();
  if (name.length > 80) return refuse(422, 'bad_pool', 'name: keep it under 80 characters.');
  return name;
}

function poolNote(raw: unknown): string {
  if (typeof raw !== 'string') return refuse(422, 'bad_pool', 'note: must be text.');
  return raw.trim().slice(0, 1000);
}

async function nameFree(tx: SqlLike, name: string, except: number | null): Promise<void> {
  const [dup] = await tx`SELECT id FROM fb_photo_pools WHERE lower(name) = lower(${name}) AND id IS DISTINCT FROM ${except}`;
  if (dup) refuse(409, 'pool_exists', `A pool named "${name}" already exists.`);
}

export async function createPool(tx: SqlLike, body: { name?: unknown; note?: unknown }, userId: string): Promise<FbPhotoPool> {
  const name = poolName(body.name);
  const note = body.note === undefined ? '' : poolNote(body.note);
  await nameFree(tx, name, null);
  const [r] = await tx<{ id: number }[]>`
    INSERT INTO fb_photo_pools (name, note, created_by) VALUES (${name}, ${note}, ${userId}) RETURNING id::int AS id`;
  return getPool(tx, r!.id);
}

export async function patchPool(tx: SqlLike, id: number, body: { name?: unknown; note?: unknown; archived?: unknown }): Promise<FbPhotoPool> {
  await getPool(tx, id);
  if (body.name !== undefined) {
    const name = poolName(body.name);
    await nameFree(tx, name, id);
    await tx`UPDATE fb_photo_pools SET name = ${name} WHERE id = ${id}`;
  }
  if (body.note !== undefined) await tx`UPDATE fb_photo_pools SET note = ${poolNote(body.note)} WHERE id = ${id}`;
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') refuse(422, 'bad_pool', 'archived: must be true or false.');
    await tx`UPDATE fb_photo_pools SET archived_at = ${body.archived ? tx`COALESCE(archived_at, NOW())` : null} WHERE id = ${id}`;
  }
  return getPool(tx, id);
}

type PhotoRow = Omit<FbPhoto, 'url'> & { r2_key: string };

export function photoDto(env: Env, r: Record<string, unknown>): FbPhoto {
  const { r2_key, ...rest } = plain<PhotoRow>(r);
  return { ...rest, url: photoUrl(env, r2_key) };
}

const PHOTO_COLS = (sql: SqlLike) => sql`
  id::int AS id, pool_id::int AS pool_id, r2_key, mime, bytes, width, height, sha256,
  uploaded_by, uploaded_at, used_at, used_by_placement::int AS used_by_placement`;

export async function listPhotos(sql: SqlLike, env: Env, poolId: number, used: 'all' | 'used' | 'unused',
  before: number | null, limit: number): Promise<FbPhoto[]> {
  const rows = await sql`
    SELECT ${PHOTO_COLS(sql)} FROM fb_photos
     WHERE pool_id = ${poolId}
       AND ${used === 'used' ? sql`used_at IS NOT NULL` : used === 'unused' ? sql`used_at IS NULL` : sql`TRUE`}
       AND ${before === null ? sql`TRUE` : sql`id < ${before}`}
     ORDER BY id DESC LIMIT ${limit}`;
  return rows.map((r) => photoDto(env, r));
}

/** The image's type and size from its first bytes; null when it is none of PNG, JPEG or WebP. */
export function sniffImage(b: Uint8Array): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number | null; height: number | null } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + dv.getUint16(i + 2);
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8X') {
      return { mime: 'image/webp', width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    }
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: 'image/webp', width: null, height: null };
  }
  return null;
}

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The photo already holding this file, named for the refusal. */
export async function duplicateOf(sql: SqlLike, sha: string): Promise<string | null> {
  const [d] = await sql<{ id: number; pool: string }[]>`
    SELECT f.id::int AS id, p.name AS pool FROM fb_photos f JOIN fb_photo_pools p ON p.id = f.pool_id WHERE f.sha256 = ${sha}`;
  return d ? `The same photo is already in pool "${d.pool}" as photo #${d.id}.` : null;
}

// ─── Ads ──────────────────────────────────────────────────────────────────────

const AD_COLS = (sql: SqlLike) => sql`
  a.id::int AS id, a.title, a.description, a.price_usd::float8 AS price_usd, a.category, a.condition,
  a.renew_days, a.photo_pool_id::int AS photo_pool_id, a.photos_min, a.photos_max, a.state,
  a.created_by, a.updated_by, a.created_at, a.updated_at,
  (SELECT COUNT(*)::int FROM fb_ad_placements l WHERE l.ad_id = a.id AND l.state IN ('live','removing')) AS live_placements`;

export async function listAds(sql: SqlLike, state: FbAdState | null): Promise<FbAd[]> {
  const rows = await sql`
    SELECT ${AD_COLS(sql)} FROM fb_ads a
     WHERE ${state ? sql`a.state = ${state}` : sql`a.state <> 'archived'`}
     ORDER BY a.updated_at DESC, a.id DESC`;
  return rows.map((r) => plain<FbAd>(r));
}

export async function getAd(sql: SqlLike, id: number, withPlacements = false): Promise<FbAd> {
  const [r] = await sql`SELECT ${AD_COLS(sql)} FROM fb_ads a WHERE a.id = ${id}`;
  if (!r) return refuse(404, 'not_found', 'There is no such ad.');
  const ad = plain<FbAd>(r);
  if (withPlacements) ad.placements = await listPlacements(sql, { adId: id, limit: 500 });
  return ad;
}

const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim()) return refuse(422, 'bad_ad', `${field}: cannot be empty.`);
  if (v.trim().length > max) return refuse(422, 'bad_ad', `${field}: keep it under ${max} characters.`);
  return v.trim();
};
const int = (v: unknown, field: string, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) return refuse(422, 'bad_ad', `${field}: must be a whole number from ${lo} to ${hi}.`);
  return v;
};

type AdFields = {
  title: string; description: string; price_usd: number; category: string; condition: string;
  renew_days: number; photo_pool_id: number | null; photos_min: number; photos_max: number;
};

async function adFields(tx: SqlLike, body: Partial<FbAdInput>, base: AdFields): Promise<AdFields> {
  const f = { ...base };
  if (body.title !== undefined) f.title = text(body.title, 'title', 100);
  if (body.description !== undefined) f.description = text(body.description, 'description', 5000);
  if (body.price_usd !== undefined) {
    if (typeof body.price_usd !== 'number' || !Number.isFinite(body.price_usd) || body.price_usd < 0 || body.price_usd >= 1e8) {
      refuse(422, 'bad_ad', 'price_usd: must be a price in dollars, zero or more.');
    }
    f.price_usd = Math.round(body.price_usd * 100) / 100;
  }
  if (body.category !== undefined) f.category = text(body.category, 'category', 60);
  if (body.condition !== undefined) f.condition = text(body.condition, 'condition', 60);
  if (body.renew_days !== undefined) f.renew_days = int(body.renew_days, 'renew_days', 1, 60);
  if (body.photos_min !== undefined) f.photos_min = int(body.photos_min, 'photos_min', 1, 10);
  if (body.photos_max !== undefined) f.photos_max = int(body.photos_max, 'photos_max', 1, 10);
  if (f.photos_max < f.photos_min) refuse(422, 'bad_ad', 'photos_max: must be at least photos_min.');
  if (body.photo_pool_id !== undefined) {
    if (body.photo_pool_id !== null) {
      const id = int(body.photo_pool_id, 'photo_pool_id', 1, Number.MAX_SAFE_INTEGER);
      const [p] = await tx`SELECT 1 FROM fb_photo_pools WHERE id = ${id}`;
      if (!p) refuse(422, 'bad_ad', 'photo_pool_id: there is no such photo pool.');
    }
    f.photo_pool_id = body.photo_pool_id;
  }
  return f;
}

export async function createAd(tx: SqlLike, body: FbAdInput, userId: string): Promise<FbAd> {
  const s = await loadFbSellerSettings(tx);
  if (body.title === undefined || body.description === undefined || body.price_usd === undefined) {
    refuse(422, 'bad_ad', 'An ad needs a title, a description and a price.');
  }
  const f = await adFields(tx, body, {
    title: '', description: '', price_usd: 0, category: 'Electronics', condition: 'Used - Good',
    renew_days: Math.min(60, Math.max(1, s.pacing.renew_days)), photo_pool_id: null, photos_min: 3, photos_max: 5,
  });
  const [r] = await tx<{ id: number }[]>`
    INSERT INTO fb_ads ${tx({ ...f, created_by: userId, updated_by: userId })} RETURNING id::int AS id`;
  return getAd(tx, r!.id);
}

export async function patchAd(tx: SqlLike, id: number, body: Partial<FbAdInput> & { state?: unknown }, userId: string): Promise<FbAd> {
  const [cur] = await tx<(AdFields & { state: FbAdState })[]>`
    SELECT title, description, price_usd::float8 AS price_usd, category, condition, renew_days,
           photo_pool_id::int AS photo_pool_id, photos_min, photos_max, state
      FROM fb_ads WHERE id = ${id} FOR UPDATE`;
  if (!cur) return refuse(404, 'not_found', 'There is no such ad.');
  const f = await adFields(tx, body, cur);
  let state = cur.state;
  if (body.state !== undefined) {
    if (!FB_AD_STATES.includes(body.state as FbAdState)) refuse(422, 'bad_ad', 'state: must be draft, ready or archived.');
    state = body.state as FbAdState;
  }
  if (state === 'ready') {
    if (f.photo_pool_id === null) refuse(422, 'bad_ad', 'An ad needs a photo pool before it is ready to post.');
    const [p] = await tx<{ archived: boolean }[]>`SELECT archived_at IS NOT NULL AS archived FROM fb_photo_pools WHERE id = ${f.photo_pool_id}`;
    if (p?.archived) refuse(422, 'bad_ad', 'The ad\'s photo pool is archived; pick another before it is ready to post.');
  }
  await tx`UPDATE fb_ads SET ${tx({ ...f, state, updated_by: userId })}, updated_at = NOW() WHERE id = ${id}`;
  return getAd(tx, id);
}

// ─── Placements ───────────────────────────────────────────────────────────────

const PLACEMENT_COLS = (sql: SqlLike) => sql`
  id::int AS id, ad_id::int AS ad_id, account_no, location, content, photo_ids::int[] AS photo_ids, state,
  renews_id::int AS renews_id, fb_listing_id, posted_at, next_renew_at, removed_at, last_error, task_id::int AS task_id,
  created_by, created_at, updated_at`;

export async function getPlacement(sql: SqlLike, id: number): Promise<FbPlacement> {
  const [r] = await sql`SELECT ${PLACEMENT_COLS(sql)} FROM fb_ad_placements WHERE id = ${id}`;
  return r ? plain<FbPlacement>(r) : refuse(404, 'not_found', 'There is no such placement.');
}

export async function listPlacements(sql: SqlLike, o: { adId?: number; state?: string | null; accountNo?: number | null;
  before?: number | null; limit: number }): Promise<FbPlacement[]> {
  const rows = await sql`
    SELECT ${PLACEMENT_COLS(sql)} FROM fb_ad_placements
     WHERE ${o.adId !== undefined ? sql`ad_id = ${o.adId}` : sql`TRUE`}
       AND ${o.state ? sql`state = ${o.state}` : sql`TRUE`}
       AND ${o.accountNo != null ? sql`account_no = ${o.accountNo}` : sql`TRUE`}
       AND ${o.before != null ? sql`id < ${o.before}` : sql`TRUE`}
     ORDER BY id DESC LIMIT ${o.limit}`;
  return rows.map((r) => plain<FbPlacement>(r));
}

const randInt = (lo: number, hi: number, rand: () => number): number => lo + Math.floor(rand() * (hi - lo + 1));

/**
 * Draws a random number of unused photos for the placement and marks them used
 * for good. Short of `photos_min`, it takes none and answers how many it lacked.
 */
export async function pickPhotos(tx: SqlLike, placementId: number, ad: { photo_pool_id: number | null; photos_min: number; photos_max: number },
  rand: () => number = Math.random): Promise<{ ok: true; ids: number[] } | { ok: false; short: number }> {
  if (ad.photo_pool_id === null) return { ok: false, short: ad.photos_min };
  const want = randInt(ad.photos_min, ad.photos_max, rand);
  const got = await tx<{ id: number }[]>`
    SELECT id::int AS id FROM fb_photos
     WHERE pool_id = ${ad.photo_pool_id} AND used_at IS NULL
     ORDER BY random() LIMIT ${want}
       FOR UPDATE SKIP LOCKED`;
  if (got.length < ad.photos_min) return { ok: false, short: ad.photos_min - got.length };
  const ids = got.map((g) => g.id);
  await tx`UPDATE fb_photos SET used_at = NOW(), used_by_placement = ${placementId} WHERE id = ANY(${ids}::bigint[]) AND used_at IS NULL`;
  await tx`UPDATE fb_ad_placements SET photo_ids = ${ids}::bigint[], state = 'queued', updated_at = NOW() WHERE id = ${placementId}`;
  return { ok: true, ids };
}

type AdForPlacement = AdFields & { id: number; state: FbAdState; pool_name: string | null; pool_archived: boolean | null };

async function lockAd(tx: SqlLike, adId: number): Promise<AdForPlacement> {
  const [ad] = await tx<AdForPlacement[]>`
    SELECT a.id::int AS id, a.title, a.description, a.price_usd::float8 AS price_usd, a.category, a.condition, a.renew_days,
           a.photo_pool_id::int AS photo_pool_id, a.photos_min, a.photos_max, a.state,
           p.name AS pool_name, p.archived_at IS NOT NULL AS pool_archived
      FROM fb_ads a LEFT JOIN fb_photo_pools p ON p.id = a.photo_pool_id
     WHERE a.id = ${adId}
       FOR UPDATE OF a`;
  return ad ?? refuse(404, 'not_found', 'There is no such ad.');
}

const contentOf = (ad: AdFields): FbPlacementContent => ({
  title: ad.title, description: ad.description, price_usd: ad.price_usd, category: ad.category, condition: ad.condition,
});

/** Inserts the placement and draws its photos; short of photos it waits as needs_photos and managers hear once. */
async function insertPlacement(tx: SqlLike, ad: AdForPlacement, accountNo: number | null, location: string,
  userId: string | null, renewsId: number | null, rand: () => number, alerted = new Set<number | null>()): Promise<FbPlacement> {
  const [p] = await tx<{ id: number }[]>`
    INSERT INTO fb_ad_placements (ad_id, account_no, location, content, state, renews_id, created_by)
    VALUES (${ad.id}, ${accountNo}, ${location}, ${tx.json(contentOf(ad))}, 'needs_photos', ${renewsId}, ${userId})
    RETURNING id::int AS id`;
  const pick = await pickPhotos(tx, p!.id, ad, rand);
  if (!pick.ok && !alerted.has(ad.photo_pool_id)) {
    alerted.add(ad.photo_pool_id);
    await alertManagers(tx, {
      kind: 'needs_photos',
      title: `Pool "${ad.pool_name ?? 'none'}" is out of photos`,
      reason: ad.photo_pool_id === null
        ? `The ad "${ad.title}" has no photo pool, so its placement in ${location} waits for one.`
        : `The ad "${ad.title}" in ${location} needs ${pick.short} more unused photo${pick.short === 1 ? '' : 's'} in pool "${ad.pool_name}" before it can be posted.`,
    });
  }
  return getPlacement(tx, p!.id);
}

const normLocation = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  return s && s.length <= 120 ? s : null;
};

export async function placeAd(tx: SqlLike, adId: number, body: { account_nos?: unknown; locations?: unknown }, userId: string,
  rand: () => number = Math.random): Promise<{ placements: FbPlacement[]; refused: { account_no: number; location: string; reason: string }[] }> {
  const accounts = Array.isArray(body.account_nos) ? body.account_nos : null;
  const locations = Array.isArray(body.locations) ? body.locations : null;
  if (!accounts?.length || !accounts.every((n) => Number.isInteger(n) && n > 0)) {
    refuse(422, 'bad_placement', 'account_nos: name at least one seller account by number.');
  }
  if (!locations?.length || locations.some((l) => normLocation(l) === null)) {
    refuse(422, 'bad_placement', 'locations: name at least one location, such as "Denver, CO".');
  }
  if (accounts!.length * locations!.length > 50) refuse(422, 'bad_placement', 'Place at most 50 at a time.');
  const ad = await lockAd(tx, adId);
  const s = await loadFbSellerSettings(tx);
  const roles = new Map((await tx<{ account_no: number; role: string }[]>`
    SELECT account_no, role FROM fleet_slots WHERE account_no = ANY(${accounts as number[]}::int[])`).map((r) => [r.account_no, r.role]));
  const placements: FbPlacement[] = [];
  const alerted = new Set<number | null>();
  const refused: { account_no: number; location: string; reason: string }[] = [];
  for (const accountNo of new Set(accounts as number[])) {
    for (const location of new Set((locations as string[]).map((l) => normLocation(l)!))) {
      let reason: string | null = null;
      if (ad.state !== 'ready') reason = `The ad is ${ad.state}, not ready to post.`;
      else if (ad.photo_pool_id === null || ad.pool_archived) reason = 'The ad has no photo pool it can draw from.';
      else if (roles.get(accountNo) !== 'seller') reason = `Account ${accountNo} is not a seller account.`;
      else {
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM fb_ad_placements
           WHERE ad_id = ${ad.id} AND lower(location) = lower(${location}) AND state <> 'failed'
             AND created_at >= (date_trunc('day', NOW() AT TIME ZONE ${s.active_hours.tz}) AT TIME ZONE ${s.active_hours.tz})`;
        if (n >= s.pacing.same_ad_location_per_day) {
          reason = `This ad already went up in ${location} ${n} time${n === 1 ? '' : 's'} today; the limit is ${s.pacing.same_ad_location_per_day} a day.`;
        }
      }
      if (reason) refused.push({ account_no: accountNo, location, reason });
      else placements.push(await insertPlacement(tx, ad, accountNo, location, userId, null, rand, alerted));
    }
  }
  return { placements, refused };
}

async function lockPlacement(tx: SqlLike, id: number): Promise<FbPlacement> {
  const [r] = await tx`SELECT ${PLACEMENT_COLS(tx)} FROM fb_ad_placements WHERE id = ${id} FOR UPDATE`;
  return r ? plain<FbPlacement>(r) : refuse(404, 'not_found', 'There is no such placement.');
}

/** A posting task still waiting or running for this placement, if any. */
async function openTask(tx: SqlLike, taskId: number | null): Promise<'ready' | 'leased' | null> {
  if (taskId === null) return null;
  const [t] = await tx<{ state: string }[]>`SELECT state FROM fleet_tasks WHERE id = ${taskId} FOR UPDATE`;
  return t?.state === 'ready' || t?.state === 'leased' ? t.state : null;
}

/**
 * A new placement of the same ad, account and location with fresh photos and
 * the ad's current text; the old one goes to removing. The tick calls this for
 * due renewals with no user.
 */
export async function renewPlacement(tx: SqlLike, id: number, userId: string | null, rand: () => number = Math.random): Promise<FbPlacement> {
  const old = await lockPlacement(tx, id);
  if (old.state !== 'live') refuse(409, 'not_live', `Only a live placement can be renewed; this one is ${old.state.replace('_', ' ')}.`);
  const ad = await lockAd(tx, old.ad_id);
  if (ad.state === 'archived') refuse(409, 'ad_archived', 'The ad is archived; remove the placement instead.');
  await tx`UPDATE fb_ad_placements SET state = 'removing', next_renew_at = NULL, updated_at = NOW() WHERE id = ${id}`;
  return insertPlacement(tx, ad, old.account_no, old.location, userId, id, rand);
}

export async function removePlacement(tx: SqlLike, id: number): Promise<FbPlacement> {
  const p = await lockPlacement(tx, id);
  switch (p.state) {
    case 'removing': case 'removed': return p;
    case 'live':
      await tx`UPDATE fb_ad_placements SET state = 'removing', next_renew_at = NULL, updated_at = NOW() WHERE id = ${id}`;
      break;
    case 'queued': case 'needs_photos': case 'failed': {
      const t = await openTask(tx, p.task_id);
      if (t === 'leased') refuse(409, 'posting', 'The seller account is posting this right now; try again in a few minutes.');
      if (t === 'ready') await tx`UPDATE fleet_tasks SET state = 'cancelled', done_at = NOW() WHERE id = ${p.task_id} AND state = 'ready'`;
      await tx`UPDATE fb_ad_placements SET state = 'removed', removed_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
      break;
    }
    case 'uncertain':
      refuse(409, 'uncertain', 'Nobody knows yet whether this is on Facebook; resolve it first.');
  }
  return getPlacement(tx, id);
}

/** A manager's word on an uncertain placement, after looking at Facebook. */
export async function resolvePlacement(tx: SqlLike, id: number, body: { live?: unknown; fb_listing_id?: unknown }): Promise<FbPlacement> {
  const p = await lockPlacement(tx, id);
  if (p.state !== 'uncertain') refuse(409, 'not_uncertain', `Only an uncertain placement is resolved by hand; this one is ${p.state.replace('_', ' ')}.`);
  if (typeof body.live !== 'boolean') refuse(422, 'bad_resolve', 'live: say whether the ad is on Facebook.');
  const listing = body.fb_listing_id === undefined || body.fb_listing_id === null ? null : String(body.fb_listing_id).trim();
  if (listing !== null && !/^\d{5,30}$/.test(listing)) refuse(422, 'bad_resolve', 'fb_listing_id: the number in the listing\'s Marketplace link.');
  if (body.live) {
    const [ad] = await tx<{ renew_days: number }[]>`SELECT renew_days FROM fb_ads WHERE id = ${p.ad_id}`;
    await tx`
      UPDATE fb_ad_placements
         SET state = 'live', fb_listing_id = COALESCE(${listing}, fb_listing_id), posted_at = COALESCE(posted_at, NOW()),
             next_renew_at = NOW() + make_interval(days => ${ad!.renew_days}), last_error = NULL, updated_at = NOW()
       WHERE id = ${id}`;
  } else if (p.posted_at) {
    await tx`UPDATE fb_ad_placements SET state = 'removed', removed_at = NOW(), next_renew_at = NULL, updated_at = NOW() WHERE id = ${id}`;
  } else {
    await tx`UPDATE fb_ad_placements SET state = 'failed', last_error = 'A manager found it was never posted.', updated_at = NOW() WHERE id = ${id}`;
  }
  return getPlacement(tx, id);
}
