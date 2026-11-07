import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type {
  AgentExtract, EvalExpectation, FbAdInput, FbAdState, FbAgentRunBrief, FbMarketMatch, FbMessage, FbPhoto,
  FbSellerAccount, FbSellerSummary, FbThreadDetail, FbThreadEvent, FbThreadRow,
} from '@recycle-erp/shared';
import { FB_AD_STATES, FB_PLACEMENT_STATES } from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { isMirror, managerSession, type ManagerEnv } from '../fleet/auth';
import { log } from '../lib/log';
import { maxBuyFor } from '../lib/market';
import { clampLimit, cursorTs, decodeCursor, encodeCursor, escapeLike } from '../lib/pagination';
import { canonPartCol, canonPartNumberJs } from '../lib/part-number';
import { getUploadLimits, getWorkspaceSetting } from '../lib/settings';
import { deleteAttachment, uploadAttachment } from '../r2';
import { saveCaseFromThread } from '../services/fbAgentEval';
import { FbAgentRefusal } from '../services/fbAgentProfiles';
import {
  createAd, createPool, duplicateOf, FbSellerRefusal, getAd, getPlacement, listAds, listPhotos, listPlacements, listPools,
  patchAd, patchPool, photoDto, placeAd, plain, removePlacement, renewPlacement, resolvePlacement, sha256Hex, sniffImage,
} from '../services/fbAds';
import { listSettingsHistory, loadFbSellerSettings, loadFbSellerSettingsRow, saveFbSellerSettings } from '../services/fbConfig';
import {
  actorFor, addThreadEvent, FbThreadRefusal, listThreads, queueOutbound, threadRow, type ThreadView,
} from '../services/fbThreads';

// ─── /api/fb-seller ───────────────────────────────────────────────────────────────
// Manager-only (CONTRACTS §5.1). Every refusal is { error, detail } with the
// detail a sentence a manager can act on.

type C = Context<ManagerEnv>;

const fbSeller = new Hono<ManagerEnv>();

fbSeller.use('*', managerSession);

// A mirror ERP holds a copy of the fleet's database; a write here would land on
// the copy and be lost at the next sync.
const refuseMirrorWrites: MiddlewareHandler<ManagerEnv> = async (c, next) => {
  if (isMirror(c.env) && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'mirror', detail: 'This ERP mirrors the fleet; make the change on the ERP that runs it.' }, 409);
  }
  return next();
};
fbSeller.use('*', refuseMirrorWrites);

const refusal = (c: C, status: 400 | 404 | 409 | 422, error: string, detail: string) => c.json({ error, detail }, status);

/** Runs the handler in one transaction and turns a refusal into its answer. */
async function inTx<T>(c: C, fn: (tx: SqlLike) => Promise<T>): Promise<Response> {
  try {
    const out = await getDb(c.env).begin((tx) => fn(tx));
    return c.json(out as object);
  } catch (e) {
    if (e instanceof FbSellerRefusal) return refusal(c, e.status, e.error, e.message);
    if (e instanceof FbThreadRefusal) return refusal(c, 409, 'refused', e.message);
    if (e instanceof FbAgentRefusal) return refusal(c, e.status, e.error, e.detail);
    throw e;
  }
}

async function readJson(c: C): Promise<Record<string, unknown> | null> {
  const b = await c.req.json().catch(() => null) as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
}

const badBody = (c: C) => refusal(c, 422, 'bad_request', 'The request needs a JSON object body.');

function idParam(c: C, name = 'id'): number | null {
  const raw = c.req.param(name) ?? '';
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}
const noSuch = (c: C, what: string) => refusal(c, 404, 'not_found', `There is no such ${what}.`);

/** An id-ordered cursor: the last id shown. */
function idCursor(raw: string | undefined): number | null {
  const cur = decodeCursor(raw);
  return cur && /^\d+$/.test(cur.id) ? Number(cur.id) : null;
}
const nextById = <T extends { id: number }>(rows: T[], limit: number) =>
  rows.length === limit ? encodeCursor({ ts: 0, id: String(rows[rows.length - 1]!.id) }) : null;

// ─── Summary ──────────────────────────────────────────────────────────────────

fbSeller.get('/summary', async (c) => {
  const sql = getDb(c.env);
  const s = await loadFbSellerSettings(sql);
  const [r] = await sql<FbSellerSummary[]>`
    SELECT (SELECT COUNT(*)::int FROM fb_threads WHERE needs_human AND closed_at IS NULL) AS needs_human,
           (SELECT COUNT(*)::int FROM fb_threads WHERE unread AND closed_at IS NULL) AS unread,
           (SELECT COUNT(*)::int FROM fb_ad_placements WHERE state = 'uncertain') AS uncertain_placements,
           (SELECT COUNT(*)::int FROM fb_ad_placements WHERE state = 'needs_photos') AS needs_photos,
           (SELECT COUNT(*)::int FROM fb_photo_pools p WHERE p.archived_at IS NULL
               AND (SELECT COUNT(*) FROM fb_photos f WHERE f.pool_id = p.id AND f.used_at IS NULL) < ${s.photos.low_pool_warning}) AS low_pools`;
  return c.json(r);
});

// ─── Settings ─────────────────────────────────────────────────────────────────

fbSeller.get('/settings', async (c) => c.json(await loadFbSellerSettingsRow(getDb(c.env))));

fbSeller.put('/settings', async (c) => {
  const body = await readJson(c);
  if (!body) return badBody(c);
  const user = c.get('user');
  const out = await getDb(c.env).begin((tx) => saveFbSellerSettings(tx, body.value, body.version, user.id));
  if (!out.ok) return refusal(c, out.status, out.error, out.detail);
  return c.json({ value: out.value, version: out.version });
});

fbSeller.get('/settings/history', async (c) => {
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const rows = await listSettingsHistory(getDb(c.env), idCursor(c.req.query('cursor')), limit);
  return c.json({ rows, next: nextById(rows, limit) });
});

// ─── Accounts ─────────────────────────────────────────────────────────────────

async function accounts(sql: SqlLike, accountNo: number | null): Promise<FbSellerAccount[]> {
  const s = await loadFbSellerSettings(sql);
  return sql<FbSellerAccount[]>`
    SELECT sl.account_no, sl.role, sl.agent_on, sl.agent_profile_id::int AS agent_profile_id, sl.worker_id,
           w.state AS account_state,
           (SELECT COUNT(*)::int FROM fb_ad_placements l WHERE l.account_no = sl.account_no AND l.state IN ('live', 'removing')) AS live_ads,
           (SELECT COUNT(*)::int FROM fb_threads t WHERE t.account_no = sl.account_no AND t.closed_at IS NULL) AS open_threads,
           (SELECT COUNT(*)::int FROM fb_threads t WHERE t.account_no = sl.account_no AND t.closed_at IS NULL AND t.needs_human) AS needs_human,
           (SELECT COUNT(*)::int FROM fb_messages m JOIN fb_threads t ON t.id = m.thread_id
             WHERE t.account_no = sl.account_no AND m.send_state = 'sent'
               AND m.sent_at >= (date_trunc('day', NOW() AT TIME ZONE ${s.active_hours.tz}) AT TIME ZONE ${s.active_hours.tz})) AS sends_today
      FROM fleet_slots sl
      LEFT JOIN fleet_workers w ON w.worker_id = sl.worker_id
     WHERE ${accountNo === null ? sql`TRUE` : sql`sl.account_no = ${accountNo}`}
     ORDER BY sl.role DESC, sl.account_no`;
}

fbSeller.get('/accounts', async (c) => c.json({ rows: await accounts(getDb(c.env), null) }));

fbSeller.patch('/accounts/:no', async (c) => {
  const no = idParam(c, 'no');
  if (no === null) return noSuch(c, 'account');
  const body = await readJson(c);
  if (!body) return badBody(c);
  const { role, agent_on: agentOn, agent_profile_id: profileId } = body;
  if (role !== undefined && role !== 'search' && role !== 'seller') return refusal(c, 422, 'bad_account', 'role: must be search or seller.');
  if (agentOn !== undefined && typeof agentOn !== 'boolean') return refusal(c, 422, 'bad_account', 'agent_on: must be true or false.');
  if (profileId !== undefined && profileId !== null && !(Number.isInteger(profileId) && (profileId as number) > 0)) {
    return refusal(c, 422, 'bad_account', 'agent_profile_id: name a profile version, or null to follow the active one.');
  }
  return inTx(c, async (tx) => {
    const [slot] = await tx`SELECT 1 FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
    if (!slot) throw new FbSellerRefusal(404, 'not_found', `Account ${no} has no fleet slot.`);
    if (profileId) {
      const [p] = await tx<{ state: string }[]>`SELECT state FROM fb_agent_profiles WHERE id = ${profileId as number}`;
      if (!p) throw new FbSellerRefusal(422, 'bad_account', 'agent_profile_id: there is no such profile version.');
      if (p.state === 'retired') throw new FbSellerRefusal(422, 'bad_account', 'agent_profile_id: that version is retired.');
    }
    // Setting the role changes no container and causes no login: the worker
    // just stops being handed search tasks (CONTRACTS §4.1).
    await tx`
      UPDATE fleet_slots
         SET role = COALESCE(${(role as string | undefined) ?? null}, role),
             agent_on = COALESCE(${(agentOn as boolean | undefined) ?? null}, agent_on),
             agent_profile_id = ${profileId === undefined ? tx`agent_profile_id` : (profileId as number | null)}
       WHERE account_no = ${no}`;
    return (await accounts(tx, no))[0];
  });
});

// ─── Photo pools ──────────────────────────────────────────────────────────────

fbSeller.get('/pools', async (c) => c.json({ rows: await listPools(getDb(c.env)) }));

fbSeller.post('/pools', async (c) => {
  const body = await readJson(c);
  if (!body) return badBody(c);
  return inTx(c, (tx) => createPool(tx, body, c.get('user').id));
});

fbSeller.patch('/pools/:id', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'photo pool');
  const body = await readJson(c);
  if (!body) return badBody(c);
  return inTx(c, (tx) => patchPool(tx, id, body));
});

fbSeller.get('/pools/:id/photos', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'photo pool');
  const used = c.req.query('used') ?? 'all';
  if (used !== 'all' && used !== 'used' && used !== 'unused') return refusal(c, 422, 'bad_request', 'used: must be all, used or unused.');
  const limit = clampLimit(c.req.query('limit'), 60, 200);
  const rows = await listPhotos(getDb(c.env), c.env, id, used, idCursor(c.req.query('cursor')), limit);
  return c.json({ rows, next: nextById(rows, limit) });
});

const PHOTO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

fbSeller.post('/pools/:id/photos', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'photo pool');
  const sql = getDb(c.env);
  const [pool] = await sql<{ archived: boolean }[]>`SELECT archived_at IS NOT NULL AS archived FROM fb_photo_pools WHERE id = ${id}`;
  if (!pool) return noSuch(c, 'photo pool');
  if (pool.archived) return refusal(c, 409, 'pool_archived', 'The pool is archived; restore it before adding photos.');
  const form = await c.req.formData().catch(() => null);
  if (!form) return refusal(c, 422, 'bad_request', 'Send the photos as multipart form data, each under the field "file".');
  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  if (files.length === 0) return refusal(c, 422, 'bad_request', 'Add at least one photo under the field "file".');
  const limits = await getUploadLimits(sql);
  const userId = c.get('user').id;
  const added: FbPhoto[] = [];
  const refused: { name: string; reason: string }[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const name = file.name || 'photo';
    if (file.size > limits.maxBytes) {
      refused.push({ name, reason: `It is ${(file.size / 1_048_576).toFixed(1)} MB; the limit is ${(limits.maxBytes / 1_048_576).toFixed(0)} MB.` });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const img = sniffImage(bytes);
    if (!img || !PHOTO_MIME.has(img.mime) || !limits.allowedMime.has(img.mime)) {
      refused.push({ name, reason: 'It is not a PNG, JPEG or WebP image.' });
      continue;
    }
    const sha = sha256Hex(bytes);
    const twin = seen.get(sha);
    if (twin) { refused.push({ name, reason: `It is the same photo as "${twin}" in this upload.` }); continue; }
    seen.set(sha, name);
    const dup = await duplicateOf(sql, sha);
    if (dup) { refused.push({ name, reason: dup }); continue; }
    const stored = await uploadAttachment(c.env, new File([bytes], name, { type: img.mime }), `fb-seller/photos/${id}`);
    const [row] = await sql`
      INSERT INTO fb_photos (pool_id, r2_key, mime, bytes, width, height, sha256, uploaded_by)
      VALUES (${id}, ${stored.storageKey}, ${img.mime}, ${bytes.length}, ${img.width}, ${img.height}, ${sha}, ${userId})
      ON CONFLICT (sha256) DO NOTHING
      RETURNING id::int AS id, pool_id::int AS pool_id, r2_key, mime, bytes, width, height, sha256,
                uploaded_by, uploaded_at, used_at, used_by_placement::int AS used_by_placement`;
    if (!row) {
      // Another upload of the same file won the race.
      await deleteAttachment(c.env, stored.storageKey).catch((e) => log.warn('fb seller: orphan photo not deleted', e));
      refused.push({ name, reason: (await duplicateOf(sql, sha)) ?? 'The same photo was just added.' });
      continue;
    }
    added.push(photoDto(c.env, row));
  }
  return c.json({ added, refused });
});

fbSeller.delete('/photos/:id', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'photo');
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx) => {
    const [p] = await tx<{ r2_key: string; used: boolean }[]>`
      SELECT r2_key, used_at IS NOT NULL AS used FROM fb_photos WHERE id = ${id} FOR UPDATE`;
    if (!p) return null;
    if (p.used) return { used: true as const };
    await tx`DELETE FROM fb_photos WHERE id = ${id}`;
    return { used: false as const, key: p.r2_key };
  });
  if (!out) return noSuch(c, 'photo');
  if (out.used) return refusal(c, 409, 'photo_used', 'This photo has been posted, so it stays on record and can never be used again.');
  await deleteAttachment(c.env, out.key).catch((e) => log.warn('fb seller: photo object not deleted', e));
  return c.json({ ok: true });
});

// ─── Ads and placements ───────────────────────────────────────────────────────

fbSeller.get('/ads', async (c) => {
  const state = c.req.query('state') ?? null;
  if (state !== null && !FB_AD_STATES.includes(state as FbAdState)) return refusal(c, 422, 'bad_request', 'state: must be draft, ready or archived.');
  return c.json({ rows: await listAds(getDb(c.env), state as FbAdState | null) });
});

fbSeller.post('/ads', async (c) => {
  const body = await readJson(c);
  if (!body) return badBody(c);
  return inTx(c, (tx) => createAd(tx, body as FbAdInput, c.get('user').id));
});

fbSeller.get('/ads/:id', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'ad');
  return inTx(c, (tx) => getAd(tx, id, true));
});

fbSeller.patch('/ads/:id', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'ad');
  const body = await readJson(c);
  if (!body) return badBody(c);
  return inTx(c, (tx) => patchAd(tx, id, body as Partial<FbAdInput>, c.get('user').id));
});

fbSeller.post('/ads/:id/place', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'ad');
  const body = await readJson(c);
  if (!body) return badBody(c);
  return inTx(c, (tx) => placeAd(tx, id, body, c.get('user').id));
});

fbSeller.get('/placements', async (c) => {
  const state = c.req.query('state') ?? null;
  if (state !== null && !(FB_PLACEMENT_STATES as readonly string[]).includes(state)) return refusal(c, 422, 'bad_request', 'state: not a placement state.');
  const acc = c.req.query('account_no');
  if (acc !== undefined && !/^\d+$/.test(acc)) return refusal(c, 422, 'bad_request', 'account_no: must be a number.');
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const rows = await listPlacements(getDb(c.env), { state, accountNo: acc === undefined ? null : Number(acc), before: idCursor(c.req.query('cursor')), limit });
  return c.json({ rows, next: nextById(rows, limit) });
});

fbSeller.post('/placements/:id/renew', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'placement');
  return inTx(c, (tx) => renewPlacement(tx, id, c.get('user').id));
});

fbSeller.post('/placements/:id/remove', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'placement');
  return inTx(c, (tx) => removePlacement(tx, id));
});

fbSeller.post('/placements/:id/resolve', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'placement');
  const body = await readJson(c);
  if (!body) return badBody(c);
  return inTx(c, (tx) => resolvePlacement(tx, id, body));
});

// ─── Threads ──────────────────────────────────────────────────────────────────

const VIEWS: readonly ThreadView[] = ['needs_human', 'inbox', 'closed'];

fbSeller.get('/threads', async (c) => {
  const view = (c.req.query('view') ?? 'needs_human') as ThreadView;
  if (!VIEWS.includes(view)) return refusal(c, 422, 'bad_request', 'view: must be needs_human, inbox or closed.');
  const acc = c.req.query('account_no');
  if (acc !== undefined && !/^\d+$/.test(acc)) return refusal(c, 422, 'bad_request', 'account_no: must be a number.');
  const q = c.req.query('q')?.trim();
  const cur = decodeCursor(c.req.query('cursor'));
  const ts = cursorTs(cur);
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const { rows, sortKeys } = await listThreads(getDb(c.env), {
    view, accountNo: acc === undefined ? null : Number(acc), q: q ? `%${escapeLike(q)}%` : null,
    cursor: ts && cur && /^\d+$/.test(cur.id) ? { ts, id: Number(cur.id) } : null, limit,
  });
  const last = rows.length === limit ? rows.length - 1 : -1;
  return c.json({
    rows: rows.map((r) => plain<FbThreadRow>(r)),
    next: last >= 0 && sortKeys[last] ? encodeCursor({ ts: sortKeys[last]!, id: String(rows[last]!.id) }) : null,
  });
});

async function marketFor(sql: SqlLike, extracted: AgentExtract | Record<string, never>): Promise<FbMarketMatch[]> {
  const items = 'items' in extracted && Array.isArray(extracted.items) ? extracted.items : [];
  const canons = [...new Set(items.map((i) => (i.part_number ? canonPartNumberJs(i.part_number) : '')).filter(Boolean))];
  if (canons.length === 0) return [];
  const canonCol = canonPartCol(sql, sql`part_number`);
  const [rows, margin] = await Promise.all([
    sql<{ canon: string; part_number: string; label: string; last_price: number | null; avg_sell: number | null; price_at: Date | null }[]>`
      SELECT DISTINCT ON (canon) ${canonCol} AS canon, part_number, label,
             last_price::float8 AS last_price, avg_sell::float8 AS avg_sell,
             CASE WHEN last_price IS NOT NULL THEN last_price_at ELSE updated_at END AS price_at
        FROM ref_prices WHERE ${canonCol} = ANY(${canons}::text[])
       ORDER BY canon, updated_at DESC, id`,
    getWorkspaceSetting(sql, 'target_margin', 0.30),
  ]);
  return rows.map((r) => ({
    canon: r.canon, part_number: r.part_number, label: r.label,
    max_buy_unit: maxBuyFor(r.last_price ?? r.avg_sell, margin),
    price_at: r.price_at ? r.price_at.toISOString() : null,
  }));
}

async function detail(sql: SqlLike, id: number): Promise<FbThreadDetail | null> {
  const row = await threadRow(sql, id);
  if (!row) return null;
  const [messages, events, runs] = await Promise.all([
    sql`
      SELECT m.id::int AS id, m.thread_id::int AS thread_id, m.seq, m.direction, m.author, m.body, m.has_image, m.send_state,
             m.task_id::int AS task_id, m.agent_run_id::int AS agent_run_id, m.staff_user_id, u.name AS staff_name,
             m.error, m.created_at, m.sent_at
        FROM fb_messages m LEFT JOIN users u ON u.id = m.staff_user_id
       WHERE m.thread_id = ${id} ORDER BY m.seq ASC NULLS LAST, m.id ASC`,
    sql`SELECT id::int AS id, thread_id::int AS thread_id, kind, actor_id, actor_name, detail, created_at
          FROM fb_thread_events WHERE thread_id = ${id} ORDER BY created_at, id`,
    sql`SELECT id::int AS id, profile_id::int AS profile_id, shadow, state, outcome, decision, cost_usd::float8 AS cost_usd,
               error, created_at, finished_at
          FROM fb_agent_runs WHERE thread_id = ${id} ORDER BY id DESC LIMIT 10`,
  ]);
  const t = plain<FbThreadRow & { extracted: AgentExtract | Record<string, never>; close_note: string | null }>(row);
  return {
    ...t,
    messages: messages.map((m) => plain<FbMessage>(m)),
    events: events.map((e) => plain<FbThreadEvent>(e)),
    runs: runs.map((r) => plain<FbAgentRunBrief>(r)),
    market: await marketFor(sql, t.extracted),
  };
}

fbSeller.get('/threads/:id', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  const d = await detail(getDb(c.env), id);
  return d ? c.json(d) : noSuch(c, 'conversation');
});

/** Locks the thread for a manager's action, or refuses when it is gone. */
async function lockThread(tx: SqlLike, id: number): Promise<{ mode: string; needs_human: boolean; closed: boolean }> {
  const [t] = await tx<{ mode: string; needs_human: boolean; closed: boolean }[]>`
    SELECT mode, needs_human, closed_at IS NOT NULL AS closed FROM fb_threads WHERE id = ${id} FOR UPDATE`;
  if (!t) throw new FbSellerRefusal(404, 'not_found', 'There is no such conversation.');
  return t;
}

fbSeller.post('/threads/:id/reply', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  const body = await readJson(c);
  if (!body) return badBody(c);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return refusal(c, 422, 'bad_reply', 'body: write the reply first.');
  if (text.length > 2000) return refusal(c, 422, 'bad_reply', 'body: keep a reply under 2000 characters; Marketplace sends it as one message.');
  return inTx(c, async (tx) => {
    await lockThread(tx, id);
    const { messageId } = await queueOutbound(tx, id, text, { author: 'staff', userId: c.get('user').id });
    const [m] = await tx`
      SELECT m.id::int AS id, m.thread_id::int AS thread_id, m.seq, m.direction, m.author, m.body, m.has_image, m.send_state,
             m.task_id::int AS task_id, m.agent_run_id::int AS agent_run_id, m.staff_user_id, u.name AS staff_name,
             m.error, m.created_at, m.sent_at
        FROM fb_messages m LEFT JOIN users u ON u.id = m.staff_user_id WHERE m.id = ${messageId}`;
    return plain<FbMessage>(m!);
  });
});

fbSeller.post('/threads/:id/take-over', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  return inTx(c, async (tx) => {
    const t = await lockThread(tx, id);
    if (t.mode !== 'human') {
      await tx`UPDATE fb_threads SET mode = 'human', updated_at = NOW() WHERE id = ${id}`;
      // The agent's replies not yet handed to the worker stay unsent.
      await tx`UPDATE fb_messages SET send_state = 'held' WHERE thread_id = ${id} AND author = 'agent' AND send_state = 'queued'`;
      await addThreadEvent(tx, id, 'taken_over', {}, await actorFor(tx, c.get('user').id));
    }
    return detail(tx, id);
  });
});

fbSeller.post('/threads/:id/hand-back', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  return inTx(c, async (tx) => {
    const t = await lockThread(tx, id);
    if (t.closed) throw new FbSellerRefusal(409, 'closed', 'The conversation is closed; the agent does not pick closed ones back up.');
    if (t.mode !== 'agent' || t.needs_human) {
      await tx`UPDATE fb_threads SET mode = 'agent', needs_human = FALSE, human_reason = NULL, human_at = NULL, updated_at = NOW() WHERE id = ${id}`;
      await addThreadEvent(tx, id, 'handed_back', {}, await actorFor(tx, c.get('user').id));
    }
    return detail(tx, id);
  });
});

fbSeller.post('/threads/:id/close', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  const body = await readJson(c);
  if (!body) return badBody(c);
  if (body.outcome !== 'won' && body.outcome !== 'lost') return refusal(c, 422, 'bad_close', 'outcome: must be won or lost.');
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return refusal(c, 422, 'bad_close', 'note: must be text.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;
  return inTx(c, async (tx) => {
    await lockThread(tx, id);
    await tx`
      UPDATE fb_threads SET stage = ${body.outcome as string}, closed_at = NOW(), close_note = ${note},
             needs_human = FALSE, unread = FALSE, updated_at = NOW()
       WHERE id = ${id}`;
    await tx`UPDATE fb_messages SET send_state = 'held' WHERE thread_id = ${id} AND author = 'agent' AND send_state = 'queued'`;
    await addThreadEvent(tx, id, 'closed', { outcome: body.outcome, note }, await actorFor(tx, c.get('user').id));
    return detail(tx, id);
  });
});

fbSeller.post('/threads/:id/read', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  const r = await getDb(c.env)`UPDATE fb_threads SET unread = FALSE WHERE id = ${id}`;
  return r.count ? c.json({ ok: true }) : noSuch(c, 'conversation');
});

function validExpectation(v: unknown): v is EvalExpectation {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return typeof e.handoff === 'boolean'
    && (e.reason_kind === undefined || typeof e.reason_kind === 'string')
    && (e.max_offer_usd === undefined || (typeof e.max_offer_usd === 'number' && Number.isFinite(e.max_offer_usd) && e.max_offer_usd >= 0))
    && (e.must_not_contain === undefined || (Array.isArray(e.must_not_contain) && e.must_not_contain.every((s) => typeof s === 'string')));
}

fbSeller.post('/threads/:id/save-case', async (c) => {
  const id = idParam(c);
  if (id === null) return noSuch(c, 'conversation');
  const body = await readJson(c);
  if (!body) return badBody(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return refusal(c, 422, 'bad_case', 'name: give the case a name under 120 characters.');
  if (!validExpectation(body.expected)) {
    return refusal(c, 422, 'bad_case', 'expected: say whether the agent should hand off, and optionally the reason kind, the highest offer and words it must not use.');
  }
  return inTx(c, async (tx) => {
    await lockThread(tx, id);
    const { caseId } = await saveCaseFromThread(tx, id, name, body.expected as EvalExpectation);
    return { case_id: caseId };
  });
});

export default fbSeller;
