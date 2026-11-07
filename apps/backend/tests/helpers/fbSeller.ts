import type { FbSellerSettings } from '@recycle-erp/shared';
import { getTestDb } from './db';

// Fixtures for the fb-seller-* tests. Every name and message here is made up.

let uidSeq = 0;

/** A pool account with a fleet slot, by default a seller whose worker is healthy. */
export async function seedSlot(o: { role?: 'search' | 'seller'; healthy?: boolean; agentOn?: boolean } = {}): Promise<number> {
  const db = getTestDb();
  uidSeq++;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name)
    VALUES (${`61550000${String(Date.now()).slice(-6)}${uidSeq}`}, 'fixtures', 'fleet', ${`w-test-${uidSeq}`})
    RETURNING no`;
  const worker = `w-test-${uidSeq}`;
  await db`INSERT INTO fleet_slots (account_no, worker_id, role, agent_on)
           VALUES (${a!.no}, ${worker}, ${o.role ?? 'seller'}, ${o.agentOn ?? false})`;
  await db`INSERT INTO fleet_workers (worker_id, account_no, epoch, state, version, last_heartbeat_at)
           VALUES (${worker}, ${a!.no}, 0, ${o.healthy === false ? 'CHECKPOINT' : 'HEALTHY'}, '99.0.0', NOW())`;
  return a!.no;
}

/** Writes a settings value straight to the row, as a manager's save would. */
export async function patchSettings(fn: (s: FbSellerSettings) => void): Promise<FbSellerSettings> {
  const db = getTestDb();
  const [row] = await db<{ value: FbSellerSettings }[]>`SELECT value FROM fb_seller_settings WHERE id = 1`;
  const v = structuredClone(row!.value);
  fn(v);
  await db`UPDATE fb_seller_settings SET value = ${db.json(v as never)}, version = version + 1 WHERE id = 1`;
  return v;
}

/** Active hours from two hours before `now` to two hours after, in UTC. */
export function hoursAround(now: Date): FbSellerSettings['active_hours'] {
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  return { start: hhmm(new Date(now.getTime() - 2 * 3600_000)), end: hhmm(new Date(now.getTime() + 2 * 3600_000)), tz: 'UTC' };
}

let pngSeq = 0;

/** A distinct PNG: a real header with a 4×3 IHDR, then bytes that make its hash unique. */
export function png(tag = ''): Uint8Array {
  pngSeq++;
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0];
  return new Uint8Array([...head, ...new TextEncoder().encode(`${tag}#${pngSeq}#${Math.random()}`)]);
}

/** Pool rows inserted directly, with `n` unused photos. */
export async function seedPool(name: string, n: number): Promise<{ poolId: number; photoIds: number[] }> {
  const db = getTestDb();
  const [p] = await db<{ id: number }[]>`INSERT INTO fb_photo_pools (name) VALUES (${name}) RETURNING id::int AS id`;
  const photoIds: number[] = [];
  for (let i = 0; i < n; i++) {
    const [f] = await db<{ id: number }[]>`
      INSERT INTO fb_photos (pool_id, r2_key, mime, bytes, sha256)
      VALUES (${p!.id}, ${`stub-${name}-${i}`}, 'image/png', 100, ${`${name}-${i}-${Math.random()}`})
      RETURNING id::int AS id`;
    photoIds.push(f!.id);
  }
  return { poolId: p!.id, photoIds };
}

export async function seedAd(poolId: number | null, o: { state?: string; min?: number; max?: number; title?: string } = {}): Promise<number> {
  const db = getTestDb();
  const [a] = await db<{ id: number }[]>`
    INSERT INTO fb_ads (title, description, price_usd, photo_pool_id, photos_min, photos_max, state)
    VALUES (${o.title ?? 'We buy server RAM'}, 'Cash for used DDR4 and DDR5 server memory.', 1, ${poolId},
            ${o.min ?? 1}, ${o.max ?? 1}, ${o.state ?? 'ready'})
    RETURNING id::int AS id`;
  return a!.id;
}

export async function seedThread(accountNo: number, o: { mode?: 'agent' | 'human'; needsHuman?: boolean } = {}): Promise<number> {
  const db = getTestDb();
  const [t] = await db<{ id: number }[]>`
    INSERT INTO fb_threads (account_no, fb_thread_id, seller_name, listing_title, mode, needs_human)
    VALUES (${accountNo}, ${`t-${Math.random().toString(36).slice(2)}`}, 'Pat Example', 'We buy server RAM',
            ${o.mode ?? 'agent'}, ${o.needsHuman ?? false})
    RETURNING id::int AS id`;
  return t!.id;
}

export async function notificationCount(kind: string): Promise<number> {
  const [r] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM notifications WHERE kind = ${kind}`;
  return r!.n;
}

export async function managerCount(): Promise<number> {
  const [r] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM users WHERE role = 'manager' AND COALESCE(active, TRUE)`;
  return r!.n;
}
