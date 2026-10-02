import type { SqlLike } from '../db';
import { deleteAttachments, r2Configured } from '../r2';
import type { Env } from '../types';
import { log } from './log';

// Photos sent through the public forms live in the public bucket, and nothing
// else ever removes them: marking a submission spam or archived only changes
// its status. A month after that it goes, photos first. A converted lot is never
// touched, even archived later to clear the inbox: its PO owns copies of the
// photos, but this row is the PO's only record of who sold it.
const PURGE_AFTER_DAYS = 30;
const BATCH = 200;
const MAX_BATCHES_PER_RUN = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PurgeBatch = {
  submissions: number;
  photos: number;
  // Rows looked at, kept or not, and the last id among them: the next batch
  // starts after it, so rows whose photos keep failing can't hold the head of
  // the queue and starve everything behind them.
  scanned: number;
  lastId: string | null;
};

export async function purgeStaleWebSubmissions(
  sql: SqlLike, env: Env,
  opts: { olderThanDays?: number; afterId?: string | null } = {},
): Promise<PurgeBatch> {
  const olderThanDays = opts.olderThanDays ?? PURGE_AFTER_DAYS;
  const afterId = opts.afterId ?? null;
  const rows = await sql<{ id: string; keys: string[] }[]>`
    SELECT ws.id,
           COALESCE(array_agg(p.storage_key) FILTER (WHERE p.storage_key IS NOT NULL), '{}') AS keys
    FROM web_submissions ws
    LEFT JOIN web_submission_photos p ON p.submission_id = ws.id
    WHERE ws.status IN ('spam', 'archived') AND ws.order_id IS NULL
      AND ws.updated_at < NOW() - make_interval(days => ${olderThanDays})
      AND (${afterId}::text IS NULL OR ws.id > ${afterId}::text)
    GROUP BY ws.id
    ORDER BY ws.id
    LIMIT ${BATCH}
  `;
  if (rows.length === 0) return { submissions: 0, photos: 0, scanned: 0, lastId: null };
  // deleteAttachments reports success for every key when R2 isn't configured,
  // so a misconfigured deploy would drop the rows and strand their objects.
  // Only a `stub-` key (never uploaded) can go without R2.
  const canDelete = r2Configured(env);
  const failed = new Set(canDelete ? await deleteAttachments(env, rows.flatMap((r) => r.keys)) : []);
  const gone = (k: string) => !failed.has(k) && (canDelete || k.startsWith('stub-'));
  // A submission whose photos did not all go keeps its row, so a later run
  // retries them rather than orphaning objects nothing points at any more.
  const done = rows.filter((r) => r.keys.every(gone));
  if (done.length > 0) {
    await sql`DELETE FROM web_submissions WHERE id = ANY(${done.map((r) => r.id)}::text[])`;
  }
  return {
    submissions: done.length,
    photos: done.reduce((n, r) => n + r.keys.length, 0),
    scanned: rows.length,
    lastId: rows[rows.length - 1]!.id,
  };
}

export function startWebSubmissionPurgeLoop(sql: SqlLike, env: Env): { stop(): void } {
  // Batches until a short one, so a backlog clears in one run.
  const run = async () => {
    const total = { submissions: 0, photos: 0 };
    try {
      let afterId: string | null = null;
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const r = await purgeStaleWebSubmissions(sql, env, { afterId });
        total.submissions += r.submissions;
        total.photos += r.photos;
        if (r.scanned < BATCH) break;
        afterId = r.lastId;
      }
    } catch (e) {
      log.error('web submission purge failed', e);
    }
    if (total.submissions > 0) log.info('purged stale web submissions', total);
  };
  // First pass a minute after boot, then daily.
  const first = setTimeout(run, 60_000);
  const handle = setInterval(run, DAY_MS);
  first.unref?.();
  handle.unref?.();
  return { stop() { clearTimeout(first); clearInterval(handle); } };
}
