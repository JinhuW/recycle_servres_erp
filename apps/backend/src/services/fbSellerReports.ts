import type { InboxThread, SellerReport } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { alertManagers } from '../lib/fbSellerAlert';
import { log } from '../lib/log';
import { enqueueAgentRun } from './fbAgent';
import { loadFbSellerSettings } from './fbConfig';
import { addThreadEvent, flagHuman } from './fbThreads';

// What a seller worker's report does to the domain (placements, threads,
// messages). The report route stores the report and calls this in the same
// transaction (CONTRACTS §4.4). Every branch is idempotent on the domain's own
// state: a second report of the same outcome finds nothing left to change.

type Result = { accepted: boolean; detail?: string };

export const UNCERTAIN_SEND_REASON = 'A reply may not have reached the seller';

export async function applySellerReport(tx: SqlLike, accountNo: number, report: SellerReport): Promise<Result> {
  const [task] = await tx<{ id: number }[]>`
    SELECT id::int AS id FROM fleet_tasks
     WHERE id = ${report.task_id} AND account_no = ${accountNo} AND kind = ${report.kind} AND payload->>'ref' = ${report.ref}`;
  if (!task) return { accepted: false, detail: 'No task of that kind and ref was handed to this account.' };
  if (report.outcome === 'wall') {
    await alertManagers(tx, {
      kind: 'wall',
      title: `Seller account ${accountNo} hit a Facebook wall`,
      reason: report.detail?.trim() || 'Facebook stopped the account partway through a task; the worker has parked it.',
    });
  }
  switch (report.kind) {
    case 'ad-post': return applyAdPost(tx, report);
    case 'ad-delete': return applyAdDelete(tx, report);
    case 'msg-send': return applyMsgSend(tx, report);
    case 'inbox-sync': return applyInbox(tx, accountNo, report);
  }
}

const reason = (r: SellerReport, fallback: string) => r.detail?.trim() || fallback;
const refId = (r: SellerReport): number | null => (/^\d+$/.test(r.ref) ? Number(r.ref) : null);

async function applyAdPost(tx: SqlLike, r: SellerReport): Promise<Result> {
  const id = refId(r);
  const [p] = id === null ? [] : await tx<{ state: string; fb_listing_id: string | null; renew_days: number }[]>`
    SELECT l.state, l.fb_listing_id, a.renew_days FROM fb_ad_placements l JOIN fb_ads a ON a.id = l.ad_id
     WHERE l.id = ${id} FOR UPDATE OF l`;
  if (!p) return { accepted: false, detail: 'No placement has that ref.' };
  if (r.outcome === 'ok') {
    const listing = (r.data as { fb_listing_id?: unknown } | undefined)?.fb_listing_id;
    if (typeof listing !== 'string' || !listing) return { accepted: false, detail: 'A posted ad needs its fb_listing_id.' };
    if (p.state === 'live' && p.fb_listing_id === listing) return { accepted: true };
    if (!['queued', 'uncertain', 'failed'].includes(p.state)) return { accepted: false, detail: `The placement is ${p.state}.` };
    const s = await loadFbSellerSettings(tx);
    const jitterDays = Math.random() * s.pacing.renew_jitter_days;
    await tx`
      UPDATE fb_ad_placements
         SET state = 'live', fb_listing_id = ${listing}, posted_at = NOW(), last_error = NULL, updated_at = NOW(),
             next_renew_at = NOW() + make_interval(days => ${p.renew_days}) + make_interval(secs => ${Math.round(jitterDays * 86400)})
       WHERE id = ${id}`;
    return { accepted: true };
  }
  if (p.state !== 'queued') return { accepted: true };
  // A publish whose result the worker could not see may be on Facebook: a
  // manager looks and resolves it. Only a plain failure is known not posted.
  const state = r.outcome === 'failed' ? 'failed' : 'uncertain';
  await tx`UPDATE fb_ad_placements SET state = ${state}, last_error = ${reason(r, 'The post did not go through.')}, updated_at = NOW() WHERE id = ${id}`;
  return { accepted: true };
}

async function applyAdDelete(tx: SqlLike, r: SellerReport): Promise<Result> {
  const id = refId(r);
  const [p] = id === null ? [] : await tx<{ state: string }[]>`SELECT state FROM fb_ad_placements WHERE id = ${id} FOR UPDATE`;
  if (!p) return { accepted: false, detail: 'No placement has that ref.' };
  if (p.state !== 'removing') return { accepted: true };
  if (r.outcome === 'ok') {
    await tx`UPDATE fb_ad_placements SET state = 'removed', removed_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = ${id}`;
  } else {
    await tx`UPDATE fb_ad_placements SET state = 'uncertain', last_error = ${reason(r, 'The listing may still be on Facebook.')}, updated_at = NOW() WHERE id = ${id}`;
  }
  return { accepted: true };
}

async function applyMsgSend(tx: SqlLike, r: SellerReport): Promise<Result> {
  const id = refId(r);
  const [m] = id === null ? [] : await tx<{ thread_id: number; send_state: string; author: string; staff_user_id: string | null }[]>`
    SELECT thread_id::int AS thread_id, send_state, author, staff_user_id FROM fb_messages WHERE id = ${id} FOR UPDATE`;
  if (!m) return { accepted: false, detail: 'No message has that ref.' };
  if (m.send_state !== 'sending' && m.send_state !== 'uncertain') return { accepted: true };
  if (r.outcome === 'ok') {
    await markSent(tx, id!, m);
  } else if (r.outcome === 'failed') {
    const why = reason(r, 'The reply could not be sent.');
    await tx`UPDATE fb_messages SET send_state = 'failed', error = ${why} WHERE id = ${id}`;
    await addThreadEvent(tx, m.thread_id, 'send_failed', { message_id: id, reason: why });
    await flagHuman(tx, m.thread_id, `A reply could not be sent: ${why}`);
  } else if (m.send_state === 'sending') {
    // Typed, maybe submitted: the next inbox sync shows whether it landed.
    const why = reason(r, 'The worker could not see whether the reply went out.');
    await tx`UPDATE fb_messages SET send_state = 'uncertain', error = ${why} WHERE id = ${id}`;
    await addThreadEvent(tx, m.thread_id, 'send_uncertain', { message_id: id, reason: why });
  }
  return { accepted: true };
}

async function markSent(tx: SqlLike, id: number, m: { thread_id: number; author: string; staff_user_id: string | null }, seq: number | null = null): Promise<void> {
  await tx`
    UPDATE fb_messages SET send_state = 'sent', sent_at = COALESCE(sent_at, NOW()), error = NULL,
           seq = COALESCE(${seq}, seq)
     WHERE id = ${id}`;
  await tx`UPDATE fb_threads SET last_outbound_at = NOW(), updated_at = NOW() WHERE id = ${m.thread_id}`;
  const [u] = m.staff_user_id ? await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${m.staff_user_id}` : [];
  await addThreadEvent(tx, m.thread_id, m.author === 'staff' ? 'staff_sent' : 'agent_sent', { message_id: id },
    m.author === 'staff' ? { id: m.staff_user_id, name: u?.name ?? 'system' } : { id: null, name: 'agent' });
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

type Msg = { direction: string; body: string };
const same = (a: Msg, b: Msg) => a.direction === b.direction && a.body === b.body;

/**
 * How many of the window's first messages are already the stored
 * conversation's last ones: the longest suffix of `stored` that is a prefix of
 * `window`. It matches whole runs, so two identical messages in a row stay two.
 */
export function alignWindow(stored: Msg[], window: Msg[]): number {
  for (let k = Math.min(stored.length, window.length); k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) ok = same(stored[stored.length - k + i]!, window[i]!);
    if (ok) return k;
  }
  return 0;
}

function validThreads(data: SellerReport['data']): InboxThread[] | null {
  const threads = (data as { threads?: unknown } | undefined)?.threads;
  if (!Array.isArray(threads)) return null;
  const ok = threads.every((t: InboxThread) =>
    t && typeof t.fb_thread_id === 'string' && t.fb_thread_id !== '' && Array.isArray(t.messages)
    && t.messages.every((m) => m && ['in', 'out', 'unknown'].includes(m.direction) && typeof m.body === 'string'));
  return ok ? threads : null;
}

async function applyInbox(tx: SqlLike, accountNo: number, r: SellerReport): Promise<Result> {
  if (r.outcome !== 'ok') return { accepted: true };
  const threads = validThreads(r.data);
  if (!threads) return { accepted: false, detail: 'An inbox report needs data.threads, each with an fb_thread_id and its messages.' };
  const s = await loadFbSellerSettings(tx);
  const [slot] = await tx<{ agent_on: boolean }[]>`SELECT agent_on FROM fleet_slots WHERE account_no = ${accountNo}`;
  for (const t of threads) {
    await ingestThread(tx, accountNo, t, { agentOn: !!slot?.agent_on, killSwitch: s.kill_switch });
  }
  return { accepted: true };
}

async function ingestThread(tx: SqlLike, accountNo: number, t: InboxThread, g: { agentOn: boolean; killSwitch: boolean }): Promise<void> {
  const [row] = await tx<{ id: number; created: boolean }[]>`
    INSERT INTO fb_threads (account_no, fb_thread_id, seller_name, listing_title, placement_id)
    VALUES (${accountNo}, ${t.fb_thread_id}, ${(t.seller_name ?? '').slice(0, 200)}, ${(t.listing_title ?? '').slice(0, 300)},
            (SELECT id FROM fb_ad_placements
              WHERE account_no = ${accountNo} AND content->>'title' = ${t.listing_title ?? ''} AND posted_at IS NOT NULL
              ORDER BY posted_at DESC LIMIT 1))
    ON CONFLICT (account_no, fb_thread_id) DO UPDATE
       SET seller_name = CASE WHEN EXCLUDED.seller_name <> '' THEN EXCLUDED.seller_name ELSE fb_threads.seller_name END
    RETURNING id::int AS id, (xmax = 0) AS created`;
  const threadId = row!.id;
  const [th] = await tx<{ mode: string; needs_human: boolean; closed: boolean; last_seq: number }[]>`
    SELECT mode, needs_human, closed_at IS NOT NULL AS closed, last_seq FROM fb_threads WHERE id = ${threadId} FOR UPDATE`;
  if (row!.created) await addThreadEvent(tx, threadId, 'created', { fb_thread_id: t.fb_thread_id });

  const stored = await tx<Msg[]>`SELECT direction, body FROM fb_messages WHERE thread_id = ${threadId} AND seq IS NOT NULL ORDER BY seq`;
  const window = t.messages.map((m) => ({ direction: m.direction, body: m.body.slice(0, 20_000), has_image: !!m.has_image }));
  const k = alignWindow(stored, window);
  const fresh = window.slice(k);
  if (k === 0 && stored.length > 0 && fresh.length > 0) {
    await addThreadEvent(tx, threadId, 'realigned', { stored: stored.length, window: window.length });
  }

  let seq = th!.last_seq;
  let trigger: number | null = null;
  let inbound = false;
  for (const m of fresh) {
    seq += 1;
    if (m.direction === 'out') {
      // Ours if an outbound we queued, not yet seen in a window, has this text.
      const [mine] = await tx<{ id: number; thread_id: number; author: string; staff_user_id: string | null; send_state: string }[]>`
        SELECT id::int AS id, thread_id::int AS thread_id, author, staff_user_id, send_state FROM fb_messages
         WHERE thread_id = ${threadId} AND seq IS NULL AND direction = 'out' AND body = ${m.body}
           AND send_state IN ('sending', 'sent', 'uncertain')
         ORDER BY id LIMIT 1 FOR UPDATE`;
      if (mine) {
        if (mine.send_state === 'sent') await tx`UPDATE fb_messages SET seq = ${seq} WHERE id = ${mine.id}`;
        else await markSent(tx, mine.id, mine, seq);
        continue;
      }
      await tx`
        INSERT INTO fb_messages (thread_id, seq, direction, author, body, has_image)
        VALUES (${threadId}, ${seq}, 'out', 'facebook', ${m.body}, ${m.has_image})`;
      continue;
    }
    // 'unknown' could be either side; the agent's rules hand it off.
    const [ins] = await tx<{ id: number }[]>`
      INSERT INTO fb_messages (thread_id, seq, direction, author, body, has_image)
      VALUES (${threadId}, ${seq}, ${m.direction}, ${m.direction === 'in' ? 'seller' : 'facebook'}, ${m.body}, ${m.has_image})
      RETURNING id::int AS id`;
    if (m.direction === 'in') {
      inbound = true;
      await addThreadEvent(tx, threadId, 'inbound', { message_id: ins!.id });
    }
    trigger = ins!.id;
  }
  if (seq !== th!.last_seq) {
    await tx`
      UPDATE fb_threads SET last_seq = ${seq}, updated_at = NOW(),
             unread = unread OR ${inbound}, last_inbound_at = CASE WHEN ${inbound} THEN NOW() ELSE last_inbound_at END
       WHERE id = ${threadId}`;
  }

  // An uncertain reply this window would have shown, had it landed, did not.
  const lost = await tx<{ id: number }[]>`
    UPDATE fb_messages SET send_state = 'failed', error = ${UNCERTAIN_SEND_REASON}
     WHERE thread_id = ${threadId} AND seq IS NULL AND send_state = 'uncertain'
    RETURNING id::int AS id`;
  for (const l of lost) await addThreadEvent(tx, threadId, 'send_failed', { message_id: l.id, reason: UNCERTAIN_SEND_REASON });
  if (lost.length > 0) await flagHuman(tx, threadId, UNCERTAIN_SEND_REASON);

  // One run per sync, on the newest message: the agent reads the whole window anyway.
  if (trigger !== null && th!.mode === 'agent' && !th!.needs_human && lost.length === 0 && !th!.closed && g.agentOn && !g.killSwitch) {
    await enqueueAgentRun(tx, threadId, trigger);
  } else if (trigger !== null) {
    log.debug('fb seller: inbound left for a person', { threadId, mode: th!.mode, needsHuman: th!.needs_human });
  }
}
