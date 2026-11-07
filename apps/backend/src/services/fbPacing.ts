import type { FbSellerSettings, SellerTaskPayload } from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { enqueueSellerTask } from '../fleet/seller';
import { alertManagers, configureFbSellerAlerts } from '../lib/fbSellerAlert';
import { log } from '../lib/log';
import type { Env } from '../types';
import { photoUrl, pickPhotos, renewPlacement } from './fbAds';
import { loadFbSellerSettings } from './fbConfig';
import { addThreadEvent } from './fbThreads';

// The seller tick (CONTRACTS §5.3): settles uncertain tasks and turns queued
// inbox syncs, messages and placements into fleet tasks, paced by the settings.
// The settings are read at the start of every pass, so a manager's change
// shows on the next one. A pass runs in one transaction under an advisory lock:
// with several backend instances, one paces at a time.

const TICK_MS = 30_000;
const FIRST_RUN_MS = 20_000;
const TICK_LOCK = 'fb-seller-tick';
const TAIL = 6;

export type TickOptions = { now?: Date; rand?: () => number; env?: Env };
export type TickResult = {
  skipped?: 'locked' | 'off_hours';
  settled: number; inbox: number; sends: number; held: number; posts: number; deletes: number; renewed: number; low_pools: number;
};

/** Minutes since local midnight in `tz`. */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return h * 60 + m;
}

export function withinActiveHours(now: Date, h: FbSellerSettings['active_hours']): boolean {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const t = localMinutes(now, h.tz);
  const start = toMin(h.start);
  const end = toMin(h.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** A stable fraction in [0, 1) from a task id, so one gap's jitter doesn't re-roll every tick. */
const jitterOf = (id: number): number => ((id * 2654435761) % 4294967296) / 4294967296;

export async function runFbSellerTick(sql: ReturnType<typeof getDb>, o: TickOptions = {}): Promise<TickResult> {
  const now = o.now ?? new Date();
  const rand = o.rand ?? Math.random;
  const r: TickResult = { settled: 0, inbox: 0, sends: 0, held: 0, posts: 0, deletes: 0, renewed: 0, low_pools: 0 };
  return sql.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${TICK_LOCK}, 0)) AS locked`;
    if (!locked) return { ...r, skipped: 'locked' as const };
    const s = await loadFbSellerSettings(tx);
    r.settled = await settleUncertain(tx);
    if (!withinActiveHours(now, s.active_hours)) return { ...r, skipped: 'off_hours' as const };
    const env = o.env;
    r.inbox = await queueInboxSyncs(tx, s, now);
    const m = await queueSends(tx, s, now);
    r.sends = m.sends; r.held = m.held;
    const a = await queueAdActions(tx, s, now, rand, env);
    r.posts = a.posts; r.deletes = a.deletes; r.renewed = a.renewed;
    r.low_pools = await lowPoolAlerts(tx, s);
    return r;
  });
}

// 1. Tasks that lost their lease mid-write: the domain hears it was uncertain.
async function settleUncertain(tx: SqlLike): Promise<number> {
  const msgs = await tx<{ id: number; thread_id: number }[]>`
    UPDATE fb_messages m SET send_state = 'uncertain', error = 'The worker lost its task while sending.'
      FROM fleet_tasks t
     WHERE t.id = m.task_id AND t.kind = 'msg-send' AND t.state = 'uncertain' AND m.send_state = 'sending'
    RETURNING m.id::int AS id, m.thread_id::int AS thread_id`;
  for (const m of msgs) await addThreadEvent(tx, m.thread_id, 'send_uncertain', { message_id: m.id, reason: 'The worker lost its task while sending.' });
  // A send task cancelled before any worker took it never ran: queue it again.
  const back = await tx`
    UPDATE fb_messages m SET send_state = 'queued', task_id = NULL
      FROM fleet_tasks t
     WHERE t.id = m.task_id AND t.kind = 'msg-send' AND t.state IN ('cancelled', 'expired') AND t.leased_at IS NULL
       AND m.send_state = 'sending'`;
  const posts = await tx`
    UPDATE fb_ad_placements l SET state = 'uncertain', last_error = 'The worker lost its task while posting or removing.', updated_at = NOW()
      FROM fleet_tasks t
     WHERE t.id = l.task_id AND t.kind IN ('ad-post', 'ad-delete') AND t.state = 'uncertain'
       AND l.state IN ('queued', 'removing')`;
  return msgs.length + back.count + posts.count;
}

// 2. Inbox syncs for seller slots whose worker is healthy.
async function queueInboxSyncs(tx: SqlLike, s: FbSellerSettings, now: Date): Promise<number> {
  const slots = await tx<{ account_no: number; last_id: number | null; last_at: Date | null; open: boolean }[]>`
    SELECT sl.account_no, last.id::int AS last_id, last.due_at AS last_at,
           EXISTS (SELECT 1 FROM fleet_tasks o WHERE o.account_no = sl.account_no AND o.kind = 'inbox-sync'
                     AND o.state IN ('ready', 'leased')) AS open
      FROM fleet_slots sl
      JOIN fleet_workers w ON w.worker_id = sl.worker_id AND w.account_no = sl.account_no AND w.state = 'HEALTHY'
      LEFT JOIN LATERAL (
        SELECT id, due_at FROM fleet_tasks t WHERE t.account_no = sl.account_no AND t.kind = 'inbox-sync'
         ORDER BY due_at DESC, id DESC LIMIT 1) last ON TRUE
     WHERE sl.role = 'seller' AND (sl.quarantined_until IS NULL OR sl.quarantined_until < ${now})
     ORDER BY sl.account_no`;
  let n = 0;
  for (const sl of slots) {
    if (sl.open) continue;
    if (sl.last_at) {
      const gapMin = s.pacing.inbox_every_minutes + jitterOf(sl.last_id!) * s.pacing.inbox_jitter_minutes;
      if (now.getTime() - sl.last_at.getTime() < gapMin * 60_000) continue;
    }
    const ref = `inbox:${now.toISOString().slice(0, 16)}`;
    const payload: SellerTaskPayload = { ref, kind: 'inbox-sync', max_threads: s.pacing.inbox_max_threads, max_messages: s.pacing.inbox_max_messages };
    if (await enqueueSellerTask(tx, sl.account_no, 'inbox-sync', ref, payload, now)) n++;
  }
  return n;
}

const startOfLocalDay = (tx: SqlLike, now: Date, tz: string) =>
  tx`(date_trunc('day', ${now}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;

// 3. Queued messages to msg-send tasks: one open per account, spaced, capped per day.
async function queueSends(tx: SqlLike, s: FbSellerSettings, now: Date): Promise<{ sends: number; held: number }> {
  // Agent messages a person now owns, or the kill switch stops, are held, never sent.
  const held = await tx`
    UPDATE fb_messages m SET send_state = 'held'
      FROM fb_threads t LEFT JOIN fleet_slots sl ON sl.account_no = t.account_no
     WHERE m.thread_id = t.id AND m.author = 'agent' AND m.send_state = 'queued'
       AND (${s.kill_switch} OR t.mode = 'human' OR t.needs_human OR t.closed_at IS NOT NULL OR NOT COALESCE(sl.agent_on, FALSE))`;
  const accounts = await tx<{ account_no: number; open: boolean; last_id: number | null; last_at: Date | null; today: number }[]>`
    SELECT sl.account_no,
           EXISTS (SELECT 1 FROM fleet_tasks o WHERE o.account_no = sl.account_no AND o.kind = 'msg-send'
                     AND o.state IN ('ready', 'leased')) AS open,
           last.id::int AS last_id, last.at AS last_at,
           (SELECT COUNT(*)::int FROM fleet_tasks d WHERE d.account_no = sl.account_no AND d.kind = 'msg-send'
              AND d.due_at >= ${startOfLocalDay(tx, now, s.active_hours.tz)}) AS today
      FROM fleet_slots sl
      LEFT JOIN LATERAL (
        SELECT id, COALESCE(done_at, leased_at, due_at) AS at FROM fleet_tasks t
         WHERE t.account_no = sl.account_no AND t.kind = 'msg-send' ORDER BY due_at DESC, id DESC LIMIT 1) last ON TRUE
     WHERE sl.role = 'seller'
       AND EXISTS (SELECT 1 FROM fb_messages m JOIN fb_threads t ON t.id = m.thread_id
                    WHERE t.account_no = sl.account_no AND m.send_state = 'queued')
     ORDER BY sl.account_no`;
  let sends = 0;
  for (const a of accounts) {
    if (a.open || a.today >= s.pacing.sends_per_account_day) continue;
    if (a.last_at) {
      const gapSec = s.pacing.send_gap_seconds + jitterOf(a.last_id!) * s.pacing.send_jitter_seconds;
      if (now.getTime() - a.last_at.getTime() < gapSec * 1000) continue;
    }
    const [m] = await tx<{ id: number; thread_id: number; fb_thread_id: string; body: string }[]>`
      SELECT m.id::int AS id, m.thread_id::int AS thread_id, t.fb_thread_id, m.body
        FROM fb_messages m JOIN fb_threads t ON t.id = m.thread_id
       WHERE t.account_no = ${a.account_no} AND m.send_state = 'queued'
       ORDER BY m.created_at, m.id LIMIT 1
         FOR UPDATE OF m SKIP LOCKED`;
    if (!m) continue;
    const tail = (await tx<{ direction: 'in' | 'out' | 'unknown'; body: string }[]>`
      SELECT direction, body FROM fb_messages WHERE thread_id = ${m.thread_id} AND seq IS NOT NULL ORDER BY seq DESC LIMIT ${TAIL}`).reverse();
    const ref = String(m.id);
    const payload: SellerTaskPayload = { ref, kind: 'msg-send', fb_thread_id: m.fb_thread_id, body: m.body, tail };
    const t = await enqueueSellerTask(tx, a.account_no, 'msg-send', ref, payload, now);
    if (!t) continue;
    await tx`UPDATE fb_messages SET send_state = 'sending', task_id = ${t.taskId} WHERE id = ${m.id}`;
    sends++;
  }
  return { sends, held: held.count };
}

// 4. Placements to ad-post / ad-delete tasks: one action per account per gap, under the live cap.
async function queueAdActions(tx: SqlLike, s: FbSellerSettings, now: Date, rand: () => number, env: Env | undefined):
  Promise<{ posts: number; deletes: number; renewed: number }> {
  let renewed = 0;
  // Due renewals: a fresh placement, and the old one comes down.
  const due = await tx<{ id: number; archived: boolean }[]>`
    SELECT l.id::int AS id, a.state = 'archived' AS archived
      FROM fb_ad_placements l JOIN fb_ads a ON a.id = l.ad_id JOIN fleet_slots sl ON sl.account_no = l.account_no
     WHERE l.state = 'live' AND l.next_renew_at <= ${now} AND sl.role = 'seller'
     ORDER BY l.next_renew_at LIMIT 20`;
  for (const d of due) {
    if (d.archived) {
      await tx`UPDATE fb_ad_placements SET state = 'removing', next_renew_at = NULL, updated_at = NOW() WHERE id = ${d.id}`;
    } else {
      await renewPlacement(tx, d.id, null, rand);
      renewed++;
    }
  }
  // Placements that were short of photos try again; managers heard once already.
  const short = await tx<{ id: number; photo_pool_id: number | null; photos_min: number; photos_max: number }[]>`
    SELECT l.id::int AS id, a.photo_pool_id::int AS photo_pool_id, a.photos_min, a.photos_max
      FROM fb_ad_placements l JOIN fb_ads a ON a.id = l.ad_id
     WHERE l.state = 'needs_photos' AND a.state = 'ready' ORDER BY l.id LIMIT 20`;
  for (const p of short) await pickPhotos(tx, p.id, p, rand);

  const accounts = await tx<{ account_no: number; open: boolean; last_id: number | null; last_at: Date | null; live: number }[]>`
    SELECT sl.account_no,
           EXISTS (SELECT 1 FROM fleet_tasks o WHERE o.account_no = sl.account_no AND o.kind IN ('ad-post', 'ad-delete')
                     AND o.state IN ('ready', 'leased')) AS open,
           last.id::int AS last_id, last.at AS last_at,
           (SELECT COUNT(*)::int FROM fb_ad_placements l WHERE l.account_no = sl.account_no AND l.state IN ('live', 'removing')) AS live
      FROM fleet_slots sl
      LEFT JOIN LATERAL (
        SELECT id, COALESCE(done_at, leased_at, due_at) AS at FROM fleet_tasks t
         WHERE t.account_no = sl.account_no AND t.kind IN ('ad-post', 'ad-delete') ORDER BY due_at DESC, id DESC LIMIT 1) last ON TRUE
     WHERE sl.role = 'seller'
       AND EXISTS (SELECT 1 FROM fb_ad_placements l WHERE l.account_no = sl.account_no AND l.state IN ('queued', 'removing'))
     ORDER BY sl.account_no`;
  let posts = 0;
  let deletes = 0;
  const openTask = (tx: SqlLike) => tx`
    (l.task_id IS NULL OR NOT EXISTS (SELECT 1 FROM fleet_tasks t WHERE t.id = l.task_id AND t.state IN ('ready', 'leased', 'uncertain', 'done')
       AND t.kind = CASE WHEN l.state = 'removing' THEN 'ad-delete' ELSE 'ad-post' END))`;
  for (const a of accounts) {
    if (a.open) continue;
    if (a.last_at && now.getTime() - a.last_at.getTime() < s.pacing.ad_action_gap_minutes * 60_000) continue;
    // Taking one down first keeps the account under its live cap.
    const [del] = await tx<{ id: number; fb_listing_id: string | null; title: string }[]>`
      SELECT l.id::int AS id, l.fb_listing_id, l.content->>'title' AS title FROM fb_ad_placements l
       WHERE l.account_no = ${a.account_no} AND l.state = 'removing' AND ${openTask(tx)}
       ORDER BY l.updated_at, l.id LIMIT 1 FOR UPDATE OF l SKIP LOCKED`;
    if (del) {
      if (!del.fb_listing_id) {
        await tx`UPDATE fb_ad_placements SET state = 'uncertain', updated_at = NOW(),
                   last_error = 'There is no listing id to remove it by; take it down on Facebook, then resolve it here.'
                 WHERE id = ${del.id}`;
        continue;
      }
      const ref = String(del.id);
      const t = await enqueueSellerTask(tx, a.account_no, 'ad-delete', ref, { ref, kind: 'ad-delete', fb_listing_id: del.fb_listing_id, title: del.title }, now);
      if (t) {
        await tx`UPDATE fb_ad_placements SET task_id = ${t.taskId}, updated_at = NOW() WHERE id = ${del.id}`;
        deletes++;
      }
      continue;
    }
    if (a.live >= s.pacing.max_live_ads_per_account) continue;
    const [post] = await tx<{ id: number; location: string; content: { title: string; description: string; price_usd: number; category: string; condition: string }; photo_ids: number[] }[]>`
      SELECT l.id::int AS id, l.location, l.content, l.photo_ids::int[] AS photo_ids FROM fb_ad_placements l
       WHERE l.account_no = ${a.account_no} AND l.state = 'queued' AND ${openTask(tx)}
       ORDER BY l.created_at, l.id LIMIT 1 FOR UPDATE OF l SKIP LOCKED`;
    if (!post) continue;
    const photos = await tx<{ r2_key: string; sha256: string }[]>`
      SELECT r2_key, sha256 FROM fb_photos WHERE id = ANY(${post.photo_ids}::bigint[]) ORDER BY array_position(${post.photo_ids}::bigint[], id)`;
    const ref = String(post.id);
    const payload: SellerTaskPayload = {
      ref, kind: 'ad-post', location: post.location, ...post.content,
      photos: photos.map((p) => ({ url: env ? photoUrl(env, p.r2_key) : p.r2_key, sha256: p.sha256 })),
    };
    const t = await enqueueSellerTask(tx, a.account_no, 'ad-post', ref, payload, now);
    if (t) {
      await tx`UPDATE fb_ad_placements SET task_id = ${t.taskId}, updated_at = NOW() WHERE id = ${post.id}`;
      posts++;
    }
  }
  return { posts, deletes, renewed };
}

// 5. Pools under the warning. "Once": no low-pool alert for this pool since its
// last upload, so refilling and running low again alerts again.
async function lowPoolAlerts(tx: SqlLike, s: FbSellerSettings): Promise<number> {
  const low = await tx<{ id: number; name: string; unused: number }[]>`
    SELECT p.id::int AS id, p.name,
           (SELECT COUNT(*)::int FROM fb_photos f WHERE f.pool_id = p.id AND f.used_at IS NULL) AS unused
      FROM fb_photo_pools p
     WHERE p.archived_at IS NULL
       AND (SELECT COUNT(*) FROM fb_photos f WHERE f.pool_id = p.id AND f.used_at IS NULL) < ${s.photos.low_pool_warning}
       AND EXISTS (SELECT 1 FROM fb_ads a WHERE a.photo_pool_id = p.id AND a.state = 'ready')
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
          WHERE n.kind = 'fb_seller_low_pool:' || p.id
            AND n.created_at >= GREATEST(p.created_at, COALESCE((SELECT MAX(uploaded_at) FROM fb_photos f WHERE f.pool_id = p.id), p.created_at)))`;
  for (const p of low) {
    await alertManagers(tx, {
      kind: `low_pool:${p.id}`,
      title: `Photo pool "${p.name}" is running low`,
      reason: `Only ${p.unused} unused photo${p.unused === 1 ? '' : 's'} left in "${p.name}"; the warning is at ${s.photos.low_pool_warning}. Every post uses fresh photos, so add more before it runs out.`,
    });
  }
  return low.length;
}

export function startFbSellerLoop(env: Env): { stop: () => void } {
  const sql = getDb(env);
  configureFbSellerAlerts({ token: env.FB_SELLER_TELEGRAM_BOT_TOKEN, sql });
  // A mirror holds a copy of the fleet's database, and a manager-only instance
  // leaves pacing to the one serving workers.
  if (env.FLEET_ROLE === 'manager-only' || env.FLEET_ROLE === 'mirror') return { stop: () => {} };
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const r = await runFbSellerTick(sql, { env });
      if (r.settled || r.inbox || r.sends || r.held || r.posts || r.deletes || r.renewed || r.low_pools) log.info('fb seller tick', r);
    } catch (e) {
      log.error('fb seller tick failed', e);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_MS);
  const handle = setInterval(() => void tick(), TICK_MS);
  first.unref?.();
  handle.unref?.();
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(handle); } };
}
