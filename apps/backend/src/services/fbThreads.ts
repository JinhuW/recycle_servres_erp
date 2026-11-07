import type { AgentExtract, FbThreadEventKind, FbThreadSnapshot, FbThreadStage } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { alertManagers } from '../lib/fbSellerAlert';
import { HONEST_LINE } from './fbAgent/guards';
import { loadFbSellerSettings } from './fbConfig';

// The thread operations the agent and the routes share (CONTRACTS §5.2). Every
// function takes a transaction.

/** queueOutbound's refusal of an agent message; `message` is the reason in words. */
export class FbThreadRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FbThreadRefusal';
  }
}

export type EventActor = { id: string | null; name: string };
const SYSTEM: EventActor = { id: null, name: 'system' };

export async function addThreadEvent(tx: SqlLike, threadId: number, kind: FbThreadEventKind,
  detail: Record<string, unknown> = {}, actor: EventActor = SYSTEM): Promise<void> {
  await tx`
    INSERT INTO fb_thread_events (thread_id, kind, actor_id, actor_name, detail)
    VALUES (${threadId}, ${kind}, ${actor.id}, ${actor.name}, ${tx.json(detail as never)})`;
}

/** The user's name for an event row, or 'system' when there is none. */
export async function actorFor(tx: SqlLike, userId: string | null): Promise<EventActor> {
  if (!userId) return SYSTEM;
  const [u] = await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${userId}`;
  return { id: userId, name: u?.name ?? 'system' };
}

type SnapshotThreadRow = Omit<FbThreadSnapshot['thread'], 'id' | 'offer_usd' | 'ceiling_usd'> & {
  id: string | number; offer_usd: string | null; ceiling_usd: string | null;
};
type SnapshotMessageRow = Omit<FbThreadSnapshot['messages'][number], 'id'> & { id: string | number };

export async function loadThreadSnapshot(tx: SqlLike, threadId: number): Promise<FbThreadSnapshot> {
  const [t] = await tx<SnapshotThreadRow[]>`
    SELECT id, account_no, stage, mode, needs_human, round, offer_usd, ceiling_usd, listing_title, extracted
      FROM fb_threads WHERE id = ${threadId}`;
  if (!t) throw new Error(`fb thread ${threadId} does not exist`);
  const messages = await tx<SnapshotMessageRow[]>`
    SELECT id, seq, direction, author, body, has_image
      FROM fb_messages WHERE thread_id = ${threadId}
     ORDER BY seq ASC NULLS LAST, id ASC`;
  return {
    thread: {
      ...t,
      id: Number(t.id),
      offer_usd: t.offer_usd === null ? null : Number(t.offer_usd),
      ceiling_usd: t.ceiling_usd === null ? null : Number(t.ceiling_usd),
    },
    messages: messages.map((m) => ({ ...m, id: Number(m.id) })),
  };
}

/**
 * Queues a message for the tick to hand to the seller worker. An agent message
 * is refused, by throwing FbThreadRefusal, when a person has the thread, the
 * account's agent is off or the kill switch is on; the checks run under the
 * thread's row lock, so a take-over that commits first always wins. A staff
 * reply is always accepted.
 */
export async function queueOutbound(tx: SqlLike, threadId: number, body: string,
  by: { author: 'agent'; agentRunId: number } | { author: 'staff'; userId: string }): Promise<{ messageId: number }> {
  const [t] = await tx<{ mode: string; needs_human: boolean; closed: boolean; agent_on: boolean | null }[]>`
    SELECT t.mode, t.needs_human, t.closed_at IS NOT NULL AS closed, s.agent_on
      FROM fb_threads t LEFT JOIN fleet_slots s ON s.account_no = t.account_no
     WHERE t.id = ${threadId}
       FOR UPDATE OF t`;
  if (!t) throw new FbThreadRefusal('The conversation no longer exists.');
  if (by.author === 'agent') {
    if (t.mode === 'human') throw new FbThreadRefusal('A manager has taken this conversation over.');
    if (t.needs_human) throw new FbThreadRefusal('This conversation is waiting for a person.');
    if (t.closed) throw new FbThreadRefusal('This conversation is closed.');
    if (!t.agent_on) throw new FbThreadRefusal("The agent is off for this seller account.");
    if ((await loadFbSellerSettings(tx)).kill_switch) throw new FbThreadRefusal('The kill switch is on, so the agent sends nothing.');
  }
  const [m] = await tx<{ id: string }[]>`
    INSERT INTO fb_messages (thread_id, direction, author, body, send_state, agent_run_id, staff_user_id)
    VALUES (${threadId}, 'out', ${by.author}, ${body}, 'queued',
            ${by.author === 'agent' ? by.agentRunId : null}, ${by.author === 'staff' ? by.userId : null})
    RETURNING id`;
  await tx`UPDATE fb_threads SET updated_at = NOW() WHERE id = ${threadId}`;
  return { messageId: Number(m!.id) };
}

/**
 * Stops the agent's unsent replies on a thread: queued ones, and ones whose
 * send task no worker has taken yet (the task is cancelled). A task already
 * leased may be typing, so it runs out. `keepHonest` leaves the bot-question
 * answer to go out: a hand-off sends it first (CONTRACTS §6.5, §6.6 guard 5).
 */
export async function holdAgentReplies(tx: SqlLike, threadId: number, o: { keepHonest: boolean }): Promise<void> {
  const keep = o.keepHonest ? tx`AND m.body <> ${HONEST_LINE}` : tx``;
  const stopped = await tx<{ id: number }[]>`
    UPDATE fleet_tasks t SET state = 'cancelled', done_at = NOW()
      FROM fb_messages m
     WHERE m.thread_id = ${threadId} AND m.author = 'agent' AND m.send_state = 'sending' AND m.task_id = t.id
       AND t.kind = 'msg-send' AND t.state = 'ready' ${keep}
    RETURNING m.id::int AS id`;
  await tx`
    UPDATE fb_messages m SET send_state = 'held', task_id = CASE WHEN m.send_state = 'sending' THEN NULL ELSE m.task_id END
     WHERE m.thread_id = ${threadId} AND m.author = 'agent' ${keep}
       AND (m.send_state = 'queued' OR m.id = ANY(${stopped.map((r) => r.id)}::bigint[]))`;
}

/** Moves the thread to Needs human with the reason in words, and tells managers. */
export async function flagHuman(tx: SqlLike, threadId: number, reason: string, detail?: Record<string, unknown>): Promise<void> {
  const [t] = await tx<{ seller_name: string; account_no: number | null }[]>`
    UPDATE fb_threads SET needs_human = TRUE, human_reason = ${reason}, human_at = NOW(), updated_at = NOW()
     WHERE id = ${threadId}
     RETURNING seller_name, account_no`;
  if (!t) return;
  // The agent's messages still waiting to go are now the person's call.
  await holdAgentReplies(tx, threadId, { keepHonest: true });
  await addThreadEvent(tx, threadId, 'handed_off', { reason, ...(detail ?? {}) });
  const who = t.seller_name || 'A seller';
  await alertManagers(tx, {
    kind: 'needs_human',
    title: `${who} needs a person (account ${t.account_no ?? '?'})`,
    reason,
    threadId,
  });
}

export async function setStage(tx: SqlLike, threadId: number, stage: FbThreadStage): Promise<void> {
  const [t] = await tx<{ from: FbThreadStage }[]>`
    WITH old AS (SELECT stage FROM fb_threads WHERE id = ${threadId} FOR UPDATE)
    UPDATE fb_threads t SET stage = ${stage}, updated_at = NOW()
      FROM old WHERE t.id = ${threadId} AND old.stage <> ${stage}
    RETURNING old.stage AS from`;
  if (t) await addThreadEvent(tx, threadId, 'stage', { from: t.from, to: stage });
}

export async function recordOffer(tx: SqlLike, threadId: number, o: { offerUsd: number; ceilingUsd: number; round: number }): Promise<void> {
  await tx`
    UPDATE fb_threads SET offer_usd = ${o.offerUsd}, ceiling_usd = ${o.ceilingUsd}, round = ${o.round}, updated_at = NOW()
     WHERE id = ${threadId}`;
  await addThreadEvent(tx, threadId, 'offer', { offer_usd: o.offerUsd, ceiling_usd: o.ceilingUsd, round: o.round });
}

export async function recordExtract(tx: SqlLike, threadId: number, extracted: AgentExtract): Promise<void> {
  await tx`UPDATE fb_threads SET extracted = ${tx.json(extracted as never)}, updated_at = NOW() WHERE id = ${threadId}`;
}

// ─── Reads for the Leads ▸ Facebook pages ─────────────────────────────────────

export type ThreadView = 'needs_human' | 'inbox' | 'closed';

const THREAD_COLS = (sql: SqlLike) => sql`
  t.id::int AS id, t.account_no, t.fb_thread_id, t.seller_name, t.listing_title, t.placement_id::int AS placement_id,
  t.stage, t.mode, t.needs_human, t.human_reason, t.human_at, t.offer_usd::float8 AS offer_usd,
  t.ceiling_usd::float8 AS ceiling_usd, t.round, t.unread, t.last_inbound_at, t.last_outbound_at,
  (SELECT m.body FROM fb_messages m WHERE m.thread_id = t.id ORDER BY m.seq DESC NULLS FIRST, m.id DESC LIMIT 1) AS last_body,
  t.closed_at, t.updated_at`;

/** The column each view sorts by, newest first; the keyset cursor compares on the same one. */
const sortCol = (sql: SqlLike, view: ThreadView) =>
  view === 'needs_human' ? sql`t.human_at` : view === 'closed' ? sql`t.closed_at` : sql`t.updated_at`;

export async function listThreads(sql: SqlLike, o: { view: ThreadView; accountNo: number | null; q: string | null;
  cursor: { ts: string; id: number } | null; limit: number }): Promise<{ rows: Record<string, unknown>[]; sortKeys: string[] }> {
  const col = sortCol(sql, o.view);
  const where = o.view === 'needs_human' ? sql`t.needs_human AND t.closed_at IS NULL`
    : o.view === 'closed' ? sql`t.closed_at IS NOT NULL` : sql`t.closed_at IS NULL`;
  const rows = await sql`
    SELECT ${THREAD_COLS(sql)},
           to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key
      FROM fb_threads t
     WHERE ${where}
       AND ${o.accountNo !== null ? sql`t.account_no = ${o.accountNo}` : sql`TRUE`}
       AND ${o.q ? sql`(t.seller_name ILIKE ${o.q} OR t.listing_title ILIKE ${o.q})` : sql`TRUE`}
       AND ${o.cursor ? sql`(${col}, t.id) < ((${o.cursor.ts}::text)::timestamptz, ${o.cursor.id})` : sql`TRUE`}
     ORDER BY ${col} DESC, t.id DESC
     LIMIT ${o.limit}`;
  return { rows: rows.map(({ sort_key, ...r }) => r), sortKeys: rows.map((r) => r.sort_key as string) };
}

export async function threadRow(sql: SqlLike, id: number): Promise<Record<string, unknown> | null> {
  const [r] = await sql`SELECT ${THREAD_COLS(sql)}, t.extracted, t.close_note FROM fb_threads t WHERE t.id = ${id}`;
  return r ?? null;
}
