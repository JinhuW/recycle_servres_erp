import { createHash } from 'node:crypto';
import { fleetCloakFor, type FleetProfileLaunchFacts, type FleetProfileVerdict } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { notifyManagers } from '../lib/notify';
import { conflict, isRefusal, type Refusal } from './sql';

// An account's browser profile: the seed it is given, and the record of what its
// browser really showed the first time. All of it happens before any Facebook
// page, so a verdict here never costs a login.

/** Taken first by anything that spends a cloak seat or an exit, or draws a seed:
 *  the checks read other accounts' rows, which no row lock of ours would keep still. */
export const ENGINE_LOCK = 'fleet-slot-engine';

const FINGERPRINT_DRAWS = 8;

const seedTaken = async (tx: SqlLike, seed: number, no: number): Promise<boolean> =>
  (await tx`SELECT 1 FROM fb_pool_accounts WHERE cloak_seed = ${seed} AND no <> ${no}`).length > 0;

/** Nothing has shown a seed that isn't stored yet, so a taken one can simply be
 *  drawn again. `after` skips the draws up to a seed that came out looking like
 *  another account's. */
export async function freeFingerprint(tx: SqlLike, no: number, after?: number): Promise<ReturnType<typeof fleetCloakFor> | Refusal> {
  let attempt = 0;
  if (after !== undefined) {
    const at = Array.from({ length: FINGERPRINT_DRAWS }, (_, i) => fleetCloakFor(no, i).cloak_seed).indexOf(after);
    attempt = at + 1;
  }
  for (; attempt < FINGERPRINT_DRAWS; attempt++) {
    const fingerprint = fleetCloakFor(no, attempt);
    if (!await seedTaken(tx, fingerprint.cloak_seed, no)) return fingerprint;
  }
  return conflict('cloak_seed_taken', `No free CloakBrowser seed was found for #${no}; two accounts on one seed are one machine`);
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 4096;
const SHA256 = /^[0-9a-f]{64}$/;

/** A worker's report, or null. Only what the fields say is kept: this ends up in the UI. */
export function readLaunchFacts(input: unknown): FleetProfileLaunchFacts | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  const screen = r.screen;
  const languages = r.languages;
  if (!Number.isInteger(r.cloak_seed)
    || !isText(r.canvas_sha256, 64) || !SHA256.test(r.canvas_sha256)
    || !isText(r.webgl_sha256, 64) || !SHA256.test(r.webgl_sha256)
    || !isCount(r.hardware_concurrency)
    || !(r.device_memory === null || isCount(r.device_memory))
    || !Array.isArray(screen) || screen.length !== 2 || !screen.every(isCount)
    || !isText(r.platform, 64)
    || !Array.isArray(languages) || languages.length > 16 || !languages.every((l) => isText(l, 32))
    || !isText(r.user_agent, 512)
    || !(r.build === null || isText(r.build, 64))) return null;
  return {
    cloak_seed: r.cloak_seed as number,
    canvas_sha256: r.canvas_sha256,
    webgl_sha256: r.webgl_sha256,
    hardware_concurrency: r.hardware_concurrency,
    device_memory: r.device_memory as number | null,
    screen: screen as [number, number],
    platform: r.platform,
    languages: languages as string[],
    user_agent: r.user_agent,
    build: r.build as string | null,
  };
}

/** The user agent and build are left out: every build bump moves them, and that
 *  alone shouldn't park a fleet. Fonts are left out for the same reason. */
export function launchFingerprint(f: FleetProfileLaunchFacts): string {
  return createHash('sha256').update(JSON.stringify([
    f.canvas_sha256, f.webgl_sha256, f.hardware_concurrency, f.device_memory, f.screen, f.platform, f.languages,
  ])).digest('hex');
}

const fingerprintHolders = async (tx: SqlLike, fingerprint: string, no: number): Promise<number[]> =>
  (await tx<{ no: number }[]>`SELECT no FROM fb_pool_accounts WHERE profile_fingerprint = ${fingerprint} AND no <> ${no} ORDER BY no`)
    .map((r) => r.no);

async function alertDuplicate(tx: SqlLike, no: number, holders: number[]): Promise<void> {
  await notifyManagers(tx, {
    kind: 'fleet_profile_duplicate', tone: 'warn', icon: 'alert',
    title: `#${no} looks like ${holders.map((h) => `#${h}`).join(', ')}`,
    body: `#${no} has shown its browser to Facebook already, so it keeps its seed: a new one would be a new device. Keep these accounts on separate exits.`,
  });
}

type Launcher = { worker_id: string; host_id: string | null; account_no: number; epoch: number };

/** The verdict on a browser that passed its preflight. Caller holds a fresh epoch. */
export async function linkLaunch(tx: SqlLike, w: Launcher, facts: FleetProfileLaunchFacts): Promise<FleetProfileVerdict> {
  const no = w.account_no;
  await tx`SELECT pg_advisory_xact_lock(hashtext(${ENGINE_LOCK}))`;
  const [account] = await tx<{ cloak_seed: number | null; first_launched_at: Date | null; fingerprint: string | null }[]>`
    SELECT cloak_seed, profile_first_launched_at AS first_launched_at, profile_fingerprint AS fingerprint
    FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
  // A seed drawn since this browser started, whose answer it never got.
  if (account.cloak_seed !== facts.cloak_seed) return 'redraw';

  const fingerprint = launchFingerprint(facts);
  const launch = { ...facts, fingerprint, at: new Date().toISOString(), worker_id: w.worker_id, host_id: w.host_id, epoch: w.epoch };
  if (account.fingerprint === fingerprint) {
    await tx`UPDATE fb_pool_accounts SET profile_launch_changed = NULL WHERE no = ${no}`;
    return 'match';
  }
  if (account.fingerprint !== null) {
    await tx`UPDATE fb_pool_accounts SET profile_launch_changed = ${tx.json(launch)} WHERE no = ${no}`;
    return 'changed';
  }

  const holders = await fingerprintHolders(tx, fingerprint, no);
  // A worker older than this report shows Facebook its seed with no record of it.
  const [shown] = await tx<{ at: Date | null }[]>`
    SELECT MIN(e.at) AS at FROM fleet_worker_state_events e
    WHERE e.account_no = ${no} AND e.engine = 'cloak' AND e.to_state NOT IN ('DEGRADED', 'DEAD')`;
  const [enrolled] = await tx<{ first_login_at: Date | null }[]>`SELECT first_login_at FROM fleet_pilot_enrollments WHERE account_no = ${no}`;
  const firstLaunch = account.first_launched_at ?? shown.at ?? enrolled?.first_login_at ?? null;
  if (firstLaunch === null && holders.length > 0) {
    const next = await freeFingerprint(tx, no, facts.cloak_seed);
    if (isRefusal(next)) return 'no_free_seed';
    await tx`UPDATE fb_pool_accounts SET cloak_seed = ${next.cloak_seed}, cloak_gpu = ${next.cloak_gpu} WHERE no = ${no}`;
    await tx`UPDATE fleet_slots SET device = device || ${tx.json(next)} WHERE account_no = ${no}`;
    await tx`UPDATE fleet_pilot_enrollments SET seed = ${next.cloak_seed} WHERE account_no = ${no} AND first_login_at IS NULL`;
    return 'redraw';
  }
  await tx`
    UPDATE fb_pool_accounts SET profile_first_launched_at = COALESCE(${firstLaunch}, NOW()),
      profile_fingerprint = ${fingerprint}, profile_launch = ${tx.json(launch)}, profile_launch_changed = NULL
    WHERE no = ${no}`;
  if (holders.length > 0) {
    await alertDuplicate(tx, no, holders);
    return 'duplicate';
  }
  return 'linked';
}

/** A manager takes a changed launch as the record, for a planned change such as a
 *  new build. Answers whether there was one to take. */
export async function acceptLaunch(tx: SqlLike, no: number, by: string): Promise<boolean> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${ENGINE_LOCK}))`;
  const [account] = await tx<{ changed: { fingerprint: string } & Record<string, unknown> | null }[]>`
    SELECT profile_launch_changed AS changed FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
  if (!account?.changed) return false;
  const launch = { ...account.changed, accepted_by: by, accepted_at: new Date().toISOString() };
  await tx`
    UPDATE fb_pool_accounts SET profile_fingerprint = ${account.changed.fingerprint}, profile_launch = ${tx.json(launch)}, profile_launch_changed = NULL
    WHERE no = ${no}`;
  const holders = await fingerprintHolders(tx, account.changed.fingerprint, no);
  if (holders.length > 0) await alertDuplicate(tx, no, holders);
  return true;
}
