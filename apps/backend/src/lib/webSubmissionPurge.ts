import type { SqlLike } from '../db';
import { deleteAttachments } from '../r2';
import type { Env } from '../types';
import { log } from './log';

// Photos sent through the public forms live in the public bucket, and nothing
// else ever removes them: marking a submission spam or archived only changes
// its status. A month after that it goes, photos first. A converted lot is never
// touched; its PO owns copies.
const PURGE_AFTER_DAYS = 30;
const BATCH = 200;
const MAX_BATCHES_PER_RUN = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeStaleWebSubmissions(
  sql: SqlLike, env: Env, olderThanDays = PURGE_AFTER_DAYS,
): Promise<{ submissions: number; photos: number }> {
  const rows = await sql<{ id: string; keys: string[] }[]>`
    SELECT ws.id,
           COALESCE(array_agg(p.storage_key) FILTER (WHERE p.storage_key IS NOT NULL), '{}') AS keys
    FROM web_submissions ws
    LEFT JOIN web_submission_photos p ON p.submission_id = ws.id
    WHERE ws.status IN ('spam', 'archived')
      AND ws.updated_at < NOW() - make_interval(days => ${olderThanDays})
    GROUP BY ws.id, ws.updated_at
    ORDER BY ws.updated_at
    LIMIT ${BATCH}
  `;
  if (rows.length === 0) return { submissions: 0, photos: 0 };
  const failed = new Set(await deleteAttachments(env, rows.flatMap((r) => r.keys)));
  // A submission whose photos did not all go keeps its row, so the next run
  // retries them rather than orphaning objects nothing points at any more.
  const done = rows.filter((r) => r.keys.every((k) => !failed.has(k)));
  if (done.length > 0) {
    await sql`DELETE FROM web_submissions WHERE id = ANY(${done.map((r) => r.id)}::text[])`;
  }
  return { submissions: done.length, photos: done.reduce((n, r) => n + r.keys.length, 0) };
}

export function startWebSubmissionPurgeLoop(sql: SqlLike, env: Env): { stop(): void } {
  // Batches until a short one, so a backlog clears in one run; the bound stops a
  // batch whose photo deletes keep failing from spinning all day.
  const run = async () => {
    const total = { submissions: 0, photos: 0 };
    try {
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const r = await purgeStaleWebSubmissions(sql, env);
        total.submissions += r.submissions;
        total.photos += r.photos;
        if (r.submissions < BATCH) break;
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
