import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type postgres from 'postgres';
import {
  FLEET_SELLER_TASK_KINDS,
  type FleetSellerTaskKind,
  type FleetWorkerTokenClaims,
  type InboxThread,
  type SellerReport,
  type SellerTaskPayload,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { getUploadLimits } from '../lib/settings';
import { uploadAttachment } from '../r2';
import { applySellerReport } from '../services/fbSellerReports';
import type { Env } from '../types';
import { checkWorkerToken, previousWorkerTokenKey, unavailable, workerTokenKey } from './auth';
import { NOTIFY_CHANNEL } from './scheduler';

// ─── Seller tasks ─────────────────────────────────────────────────────────────
// The seller side queues its Facebook work here, and the worker reports what
// it did here. A report is a fact about Facebook: a post may be live or a
// message sent even though the lease that ran it is gone. So these routes
// check only that the token is genuine and that the task was this worker's.
// They never answer 401 or 409 over an epoch or a lost lease: the worker exits
// on those, and every exit is a Facebook login.

const flog = log.child({ module: 'fleet' });

/** CONTRACTS §4.4. Under the 1 MiB JSON cap every route has (index.ts); the
 *  Cloudflare Worker streams bodies through, and its own ceiling is 100 MB. */
export const SELLER_BODY_LIMIT = 512 * 1024;

const sellerKinds: readonly string[] = FLEET_SELLER_TASK_KINDS;
const OUTCOMES = new Set(['ok', 'failed', 'uncertain', 'wall']);
const DIRECTIONS = new Set(['in', 'out', 'unknown']);
const MAX_REF = 200;
const MAX_DETAIL = 2000;
const STEP = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The only way a seller task enters fleet_tasks (CONTRACTS §5.3). Null when
 * a task with this ref is already open for the account and kind.
 */
export async function enqueueSellerTask(tx: SqlLike, accountNo: number, kind: FleetSellerTaskKind, ref: string,
  payload: SellerTaskPayload, dueAt: Date): Promise<{ taskId: number } | null> {
  if (payload.kind !== kind || payload.ref !== ref) throw new Error(`seller payload is ${payload.kind}/${payload.ref}, not ${kind}/${ref}`);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, account_no, payload)
    VALUES (NULL, NULL, ${kind}, ${dueAt}, 0, 'ready', ${accountNo}, ${tx.json(payload as unknown as postgres.JSONValue)})
    ON CONFLICT DO NOTHING
    RETURNING id::int AS id`;
  if (!row) return null;
  // Through the caller's handle, so the wake fires on commit (scheduler.ts).
  if (dueAt.getTime() <= Date.now()) await tx`SELECT pg_notify(${NOTIFY_CHANNEL}, '')`;
  return { taskId: row.id };
}

// ─── Validation ───────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readThread(v: unknown): InboxThread | string {
  if (!isRecord(v)) return 'threads[] must be objects';
  for (const k of ['fb_thread_id', 'seller_name', 'listing_title'] as const) {
    if (typeof v[k] !== 'string') return `threads[].${k} must be a string`;
  }
  if (!(v.fb_thread_id as string)) return 'threads[].fb_thread_id is empty';
  if (!Array.isArray(v.messages)) return 'threads[].messages must be a list';
  for (const m of v.messages) {
    if (!isRecord(m) || typeof m.direction !== 'string' || !DIRECTIONS.has(m.direction)
      || typeof m.body !== 'string' || typeof m.has_image !== 'boolean') {
      return 'threads[].messages[] must be { direction: in | out | unknown, body, has_image }';
    }
  }
  return v as InboxThread;
}

/** The report, or why it is malformed (a 422). */
export function readSellerReport(v: unknown): SellerReport | string {
  if (!isRecord(v)) return 'body must be a JSON object';
  const { task_id, kind, ref, outcome, detail, data } = v;
  if (!Number.isInteger(task_id) || (task_id as number) <= 0) return 'task_id must be a positive whole number';
  if (typeof kind !== 'string' || !sellerKinds.includes(kind)) return `kind must be one of ${sellerKinds.join(', ')}`;
  if (typeof ref !== 'string' || !ref || ref.length > MAX_REF) return `ref must be a string of 1 to ${MAX_REF} characters`;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return 'outcome must be ok, failed, uncertain or wall';
  if (detail !== undefined && detail !== null && typeof detail !== 'string') return 'detail must be a string';
  if (data !== undefined && data !== null && !isRecord(data)) return 'data must be an object';
  if (outcome === 'ok') {
    const d = (data ?? {}) as Record<string, unknown>;
    if (kind === 'ad-post' && (typeof d.fb_listing_id !== 'string' || !d.fb_listing_id)) return 'an ad-post ok needs data.fb_listing_id';
    if (kind === 'msg-send' && typeof d.already_sent !== 'boolean') return 'a msg-send ok needs data.already_sent';
    if (kind === 'inbox-sync') {
      if (!Array.isArray(d.threads)) return 'an inbox-sync ok needs data.threads';
      for (const t of d.threads) {
        const r = readThread(t);
        if (typeof r === 'string') return r;
      }
    }
  }
  return {
    task_id: task_id as number,
    kind: kind as FleetSellerTaskKind,
    ref,
    outcome: outcome as SellerReport['outcome'],
    ...(typeof detail === 'string' ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
    ...(isRecord(data) ? { data: data as SellerReport['data'] } : {}),
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

type SellerEnv = { Bindings: Env; Variables: { claims: FleetWorkerTokenClaims } };

/** The worker token's signature and expiry, not its epoch: see the top of the file. */
const sellerAuth: MiddlewareHandler<SellerEnv> = async (c, next) => {
  const key = workerTokenKey(c.env);
  if (!key) return c.json(unavailable('FLEET_WORKER_TOKEN_KEY'), 503);
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)\s*$/)?.[1];
  if (!token) return c.json({ error: 'unauthorized', detail: 'missing_token' }, 401);
  const checked = checkWorkerToken(token, key, previousWorkerTokenKey(c.env));
  if (!checked.ok) return c.json({ error: 'unauthorized', detail: checked.reason }, 401);
  c.set('claims', checked.claims);
  return next();
};

type OwnTask = { id: number; kind: string; account_no: number | null; ref: string | null };

/** Why this worker may not report on this task, or null when it may: the
 *  task is its account's, of the kind and ref it names, and was handed to it. */
async function refuseTask(tx: SqlLike, w: FleetWorkerTokenClaims, taskId: number, kind: string | null, ref: string): Promise<string | null> {
  const [task] = await tx<OwnTask[]>`
    SELECT id::int AS id, kind, account_no, payload->>'ref' AS ref FROM fleet_tasks WHERE id = ${taskId} FOR UPDATE`;
  if (!task) return `Task ${taskId} does not exist`;
  if (task.account_no !== w.account_no) return `Task ${taskId} belongs to another account`;
  if (kind !== null && task.kind !== kind) return `Task ${taskId} is a ${task.kind} task, not ${kind}`;
  if (task.ref !== ref) return `Task ${taskId} has a different ref`;
  const [handed] = await tx`
    SELECT 1 FROM fleet_task_events WHERE task_id = ${taskId} AND kind = 'handed' AND worker_id = ${w.worker_id} LIMIT 1`;
  if (!handed) return `Task ${taskId} was never handed to ${w.worker_id}`;
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const seller = new Hono<SellerEnv>();

const limit = bodyLimit({
  maxSize: SELLER_BODY_LIMIT,
  onError: (c) => c.json({ error: 'bad_request', detail: `The body is over ${SELLER_BODY_LIMIT / 1024} KB` }, 413),
});

seller.post('/report', limit, sellerAuth, async (c) => {
  const w = c.var.claims;
  const report = readSellerReport(await c.req.json().catch(() => null));
  if (typeof report === 'string') return c.json({ error: 'bad_request', detail: report }, 422);
  const answer = await getDb(c.env).begin(async (tx): Promise<{ accepted: boolean; detail?: string }> => {
    const refused = await refuseTask(tx, w, report.task_id, report.kind, report.ref);
    if (refused) return { accepted: false, detail: refused };
    // The same outcome for the same account, kind and ref was already applied:
    // a retry after a lost answer gets that answer again.
    const [seen] = await tx<{ answer: { accepted: boolean; detail?: string } | null }[]>`
      SELECT e.detail->'answer' AS answer FROM fleet_task_events e JOIN fleet_tasks t ON t.id = e.task_id
      WHERE e.kind = 'seller_report' AND t.account_no = ${w.account_no} AND t.kind = ${report.kind}
        AND t.payload->>'ref' = ${report.ref} AND e.detail->'report'->>'outcome' = ${report.outcome}
      ORDER BY e.id LIMIT 1`;
    if (seen) return seen.answer ?? { accepted: true };
    const applied = await applySellerReport(tx, w.account_no, report);
    await tx`
      INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
      VALUES (${report.task_id}, ${w.worker_id}, 'seller_report',
              ${tx.json({ report, answer: applied, epoch: w.epoch } as unknown as postgres.JSONValue)})`;
    return applied;
  });
  flog.info('fleet seller report', {
    accountNo: w.account_no, workerId: w.worker_id, taskId: report.task_id, kind: report.kind, outcome: report.outcome, accepted: answer.accepted,
  });
  return c.json(answer);
});

seller.post('/screenshot', limit, sellerAuth, async (c) => {
  const w = c.var.claims;
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: 'bad_request', detail: 'The body must be multipart form data' }, 422);
  const taskId = Number(form.task_id);
  const ref = form.ref;
  const step = form.step;
  const file = form.file;
  if (!Number.isInteger(taskId) || taskId <= 0) return c.json({ error: 'bad_request', detail: 'task_id must be a positive whole number' }, 422);
  if (typeof ref !== 'string' || !ref || ref.length > MAX_REF) return c.json({ error: 'bad_request', detail: 'ref' }, 422);
  if (typeof step !== 'string' || !STEP.test(step)) return c.json({ error: 'bad_request', detail: 'step must be 1 to 40 letters, digits, - or _' }, 422);
  if (!(file instanceof File)) return c.json({ error: 'bad_request', detail: 'file must be an image' }, 422);
  const sql = getDb(c.env);
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  if (!file.type.startsWith('image/') || !allowedMime.has(file.type)) {
    return c.json({ error: 'bad_request', detail: `${file.type || 'This type'} is not an image type uploads allow` }, 422);
  }
  if (file.size > maxBytes) return c.json({ error: 'bad_request', detail: `The image is over ${maxBytes} bytes` }, 422);
  const refused = await sql.begin((tx) => refuseTask(tx, w, taskId, null, ref));
  if (refused) return c.json({ ok: false, detail: refused });
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const named = new File([file], `${taskId}-${step}.${ext}`, { type: file.type });
  try {
    const stored = await uploadAttachment(c.env, named, `fb-seller/screenshots/${w.account_no}`);
    return c.json({ ok: true, key: stored.storageKey });
  } catch (e) {
    flog.warn('fleet seller screenshot not stored', { accountNo: w.account_no, taskId, error: e instanceof Error ? e.message : String(e) });
    return c.json({ ok: false, detail: 'The image store is unavailable' }, 502);
  }
});

export default seller;
