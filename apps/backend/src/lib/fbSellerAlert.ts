import type { SqlLike } from '../db';
import { log } from './log';
import { notifyManagers } from './notify';

// Tells managers about a seller-side event: in-app inside the transaction, and
// on Telegram after commit when a token and chat are set. The text gives the
// reason in words, never a status code.
//
// postgres.js has no after-commit hook, so the Telegram send remembers the
// alerting transaction's id and asks Postgres (pg_xact_status) whether it
// committed before sending. A rolled-back alert is never sent.

type Pending = { xid: string; chatId: string; text: string; since: number };

const POLL_MS = 1_000;
const GIVE_UP_MS = 5 * 60_000;
const TELEGRAM_TIMEOUT_MS = 10_000;

let botToken: string | null = null;
let pool: SqlLike | null = null;
let send: (token: string, chatId: string, text: string) => Promise<void> = telegramSend;
const pending: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let draining: Promise<void> | null = null;

/** Called at boot: the bot token from env, and a pool connection outside any alerting transaction. */
export function configureFbSellerAlerts(o: { token: string | undefined; sql: SqlLike }): void {
  botToken = o.token?.trim() || null;
  pool = o.sql;
}

/** Tests replace the Telegram call. */
export function setTelegramSenderForTests(fn: typeof send | null): void {
  send = fn ?? telegramSend;
}

export async function alertManagers(tx: SqlLike, a: { kind: string; title: string; reason: string; threadId?: number }): Promise<void> {
  await notifyManagers(tx, { kind: `fb_seller_${a.kind}`, tone: 'warn', icon: 'alert', title: a.title, body: a.reason });
  if (!botToken || !pool) return;
  const [s] = await tx<{ chat: string | null }[]>`
    SELECT value->'alerts'->>'telegram_chat_id' AS chat FROM fb_seller_settings WHERE id = 1`;
  if (!s?.chat) return;
  const [{ xid }] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
  const link = a.threadId ? `\nLeads ▸ Facebook, thread ${a.threadId}` : '';
  pending.push({ xid, chatId: s.chat, text: `${a.title}\n${a.reason}${link}`, since: Date.now() });
  schedule();
}

function schedule(): void {
  if (timer || pending.length === 0) return;
  timer = setTimeout(() => { timer = null; void drainFbSellerTelegram(); }, POLL_MS);
  timer.unref?.();
}

/** Sends every queued alert whose transaction committed and drops the rolled-back ones. */
export function drainFbSellerTelegram(): Promise<void> {
  draining ??= drain().finally(() => { draining = null; schedule(); });
  return draining;
}

async function drain(): Promise<void> {
  if (!pool || pending.length === 0) return;
  const batch = pending.splice(0);
  const xids = [...new Set(batch.map((p) => p.xid))];
  let status: Map<string, string>;
  try {
    const rows = await pool<{ xid: string; status: string | null }[]>`
      SELECT x AS xid, pg_xact_status(x::xid8) AS status FROM unnest(${xids}::text[]) AS x`;
    status = new Map(rows.map((r) => [r.xid, r.status ?? 'aborted']));
  } catch (e) {
    log.warn('fb seller alert: could not read transaction status', e);
    pending.push(...batch);
    return;
  }
  for (const p of batch) {
    const st = status.get(p.xid);
    if (st === 'in progress') {
      if (Date.now() - p.since < GIVE_UP_MS) pending.push(p);
      continue;
    }
    if (st !== 'committed' || !botToken) continue;
    try {
      await send(botToken, p.chatId, p.text);
    } catch (e) {
      log.warn('fb seller alert: Telegram send failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

async function telegramSend(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  // The URL carries the token, so the error names Telegram's own description only.
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { description?: string } | null;
    throw new Error(body?.description ?? 'Telegram refused the message');
  }
}
