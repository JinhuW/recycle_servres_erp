import type { Sql } from 'postgres';
import { log } from '../lib/log';
import { poolKey } from '../lib/sealed';
import type { Env } from '../types';

// ─── Weekly liveness check for the Facebook account pool ─────────────────────
// A disabled account otherwise sits as Available until a purchaser takes it.
// Facebook's public picture endpoint tells an existing account from a gone one
// without a login: a real one gets an scontent image with dimensions, a
// disabled or deleted one a static placeholder or "does not exist". It is an
// anonymous lookup, not a session, so it says nothing to Facebook about the
// account's own logins.
//
// "Weekly" lives in alive_checked_at, not in the timer: Railway redeploys far
// more often than once a week, and every deploy resets the interval.

export type Liveness = 'alive' | 'dead' | 'unknown';
export type Probe = (uid: string) => Promise<Liveness>;

const RECHECK_AFTER_DAYS = 7;
const BATCH = 50;
const TICK_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
// Sequential and spaced out: a pool is dozens of accounts, and a burst from
// one IP is the quickest way to get the endpoint rate-limited.
const GAP_MS = 2_000;
const ACTOR = 'Weekly check';
const CHECKED: readonly string[] = ['available', 'taken', 'fleet'];

type PictureBody = {
  data?: { url?: string; height?: number; width?: number };
  error?: { message?: string };
};

/** Reads the picture endpoint's answer; anything it doesn't recognise is unknown. */
export function classifyPicture(body: PictureBody): Liveness {
  if (body.error) return /does not exist/i.test(body.error.message ?? '') ? 'dead' : 'unknown';
  const url = body.data?.url ?? '';
  if (/^https:\/\/static\.[^/]*fbcdn\.net\/rsrc\.php\//.test(url)) return 'dead';
  if (/^https:\/\/scontent[^/]*\.fbcdn\.net\//.test(url) && body.data?.height) return 'alive';
  return 'unknown';
}

export const probeFbUid: Probe = async (uid) => {
  try {
    const res = await fetch(`https://graph.facebook.com/${uid}/picture?redirect=false`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // "Does not exist" comes back as a 400 with a JSON body; a 5xx or a rate
    // limit says nothing about the account.
    if (res.status >= 500 || res.status === 429) return 'unknown';
    return classifyPicture((await res.json()) as PictureBody);
  } catch {
    return 'unknown';
  }
};

const dueFrag = (sql: Sql<{}>) => sql`(alive_checked_at IS NULL
  OR alive_checked_at < NOW() - make_interval(days => ${RECHECK_AFTER_DAYS}))`;

export type LivenessPass = { checked: number; dead: number[]; unknown: number };

export async function checkPoolLiveness(
  sql: Sql<{}>,
  opts: { probe?: Probe; gapMs?: number; stopping?: () => boolean } = {},
): Promise<LivenessPass> {
  const probe = opts.probe ?? probeFbUid;
  const gapMs = opts.gapMs ?? GAP_MS;
  const stopping = opts.stopping ?? (() => false);
  const due = await sql<{ no: number; uid: string }[]>`
    SELECT no, uid FROM fb_pool_accounts
    WHERE status = ANY(${CHECKED as string[]}::text[]) AND ${dueFrag(sql)}
    ORDER BY alive_checked_at NULLS FIRST, no
    LIMIT ${BATCH}
  `;
  const pass: LivenessPass = { checked: 0, dead: [], unknown: 0 };
  for (const [i, candidate] of due.entries()) {
    if (stopping()) break;
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    // Claimed one at a time, right before its probe, so another instance's
    // pass skips it, and a shutdown mid-pass (Railway redeploys often; the
    // process exits without waiting for the pass) leaves at most this one
    // stamped as checked without a probe.
    const [account] = await sql<{ no: number; uid: string; prev: Date | null }[]>`
      WITH c AS (
        SELECT no, alive_checked_at AS prev FROM fb_pool_accounts
        WHERE no = ${candidate.no} AND status = ANY(${CHECKED as string[]}::text[]) AND ${dueFrag(sql)}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE fb_pool_accounts a SET alive_checked_at = NOW()
      FROM c WHERE a.no = c.no
      RETURNING a.no, a.uid, c.prev
    `;
    if (!account) continue;
    const verdict = await probe(account.uid);
    pass.checked++;
    if (verdict === 'unknown') {
      pass.unknown++;
      await sql`UPDATE fb_pool_accounts SET alive_checked_at = ${account.prev} WHERE no = ${account.no}`;
    } else if (verdict === 'dead') {
      const moved = await sql.begin(async (tx) => {
        // A manager's edit since the claim wins. The holder stays, as on a
        // purchaser's report: it names who had the account when it died.
        const rows = await tx`
          UPDATE fb_pool_accounts SET status = 'problem', updated_at = NOW()
          WHERE no = ${account.no} AND status = ANY(${CHECKED as string[]}::text[])
          RETURNING no`;
        if (rows.length === 0) return false;
        await tx`
          INSERT INTO fb_pool_events (account_no, actor_id, actor_name, kind, status, detail)
          VALUES (${account.no}, NULL, ${ACTOR}, 'reported', 'problem', 'disabled')`;
        return true;
      });
      if (moved) pass.dead.push(account.no);
    }
  }
  return pass;
}

export function startFbPoolAliveCheckLoop(sql: Sql<{}>, env: Env): { stop(): void } {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy || !poolKey(env)) return;
    busy = true;
    try {
      const pass = await checkPoolLiveness(sql, { stopping: () => stopped });
      if (pass.dead.length > 0) log.info('fb pool accounts found disabled', { accounts: pass.dead });
      if (pass.unknown > 0) log.warn('fb pool liveness probes inconclusive', { count: pass.unknown });
    } catch (e) {
      log.error('fb pool liveness check failed', e);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_MS);
  const handle = setInterval(() => void tick(), TICK_MS);
  first.unref?.();
  handle.unref?.();
  return { stop() { stopped = true; clearTimeout(first); clearInterval(handle); } };
}
