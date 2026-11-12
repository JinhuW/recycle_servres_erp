import { Hono, type MiddlewareHandler } from 'hono';
import { authMiddleware } from '../auth';
import { getDb } from '../db';
import {
  FbChatPushError, parseBuyerPush, parseClaim, parseEventPush, parseSendResult, parseSyncPush,
} from '../lib/fbChat';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { bearerGuard } from '../oauth/guard';
import { claimReply, ingestBuyer, ingestSync, recordEvent, recordSendResult } from '../services/fbChat';
import { fbChatTelegramConfigured, kickFbChatTelegram } from '../services/fbChatTelegram';
import type { Env, OAuthCtx, User } from '../types';

// ─── Facebook chat hub ────────────────────────────────────────────────────────
// The owner's Chrome extensions, one per browser profile and Facebook account,
// push their Marketplace conversations here with a fbchat:write service token
// and claim the replies typed in Telegram. The backend owns the one bot, so
// any number of extensions share one group. Self-applies its auth (oauthAdmin
// pattern): Bearer on /push/*, the session cookie and a manager gate on the
// reads.

type Vars = { user: User; oauthCtx: OAuthCtx };

const PUSH_PREFIX = '/api/fb-chat/push/';
const isPush = (path: string) => path.startsWith(PUSH_PREFIX);
// How often a held claim looks again. A reply queued by another instance has
// no in-process wake-up, so this is also the worst-case delay.
const HOLD_STEP_MS = 1_000;

const asVars = (mw: unknown) => mw as MiddlewareHandler<{ Bindings: Env; Variables: Vars }>;
const pushGuard = asVars(bearerGuard({ scopes: ['fbchat:write'] }));

const fbChat = new Hono<{ Bindings: Env; Variables: Vars }>()
  .use('*', (c, next) => (isPush(c.req.path) ? pushGuard(c, next) : asVars(authMiddleware)(c, next)))
  .use('*', (c, next) => (isPush(c.req.path) ? next() : asVars(requireManager)(c, next)));

/** Parses the body, or answers 400 with the reason. */
async function parsed<T>(c: { req: { json: () => Promise<unknown> } }, parse: (v: unknown) => T): Promise<T | string> {
  try {
    return parse(await c.req.json().catch(() => null));
  } catch (err) {
    if (err instanceof FbChatPushError) return err.message;
    throw err;
  }
}
const invalid = (detail: string) => ({ error: 'invalid_request', detail });

// ── Push ──────────────────────────────────────────────────────────────────────

fbChat.post('/push/sync', async (c) => {
  const push = await parsed(c, parseSyncPush);
  if (typeof push === 'string') return c.json(invalid(push), 400);
  const answer = await getDb(c.env).begin((tx) => ingestSync(tx, push, c.var.oauthCtx.clientId));
  if (answer.added) kickFbChatTelegram();
  return c.json(answer);
});

fbChat.post('/push/buyer', async (c) => {
  const push = await parsed(c, parseBuyerPush);
  if (typeof push === 'string') return c.json(invalid(push), 400);
  const known = await getDb(c.env).begin((tx) => ingestBuyer(tx, push, c.var.oauthCtx.clientId));
  if (!known) return c.json({ error: 'not_found' }, 404);
  kickFbChatTelegram();
  return c.json({ ok: true });
});

fbChat.post('/push/outbox/claim', async (c) => {
  const req = await parsed(c, parseClaim);
  if (typeof req === 'string') return c.json(invalid(req), 400);
  const sql = getDb(c.env);
  const deadline = Date.now() + req.wait * 1000;
  for (;;) {
    const claimed = await sql.begin((tx) => claimReply(tx, req.account, c.var.oauthCtx.clientId));
    if (claimed) {
      log.info('fb chat reply claimed', { module: 'fbChat', id: claimed.id, clientId: c.var.oauthCtx.clientId });
      return c.json(claimed);
    }
    if (Date.now() + HOLD_STEP_MS > deadline || c.req.raw.signal.aborted) return c.body(null, 204);
    await new Promise((resolve) => setTimeout(resolve, HOLD_STEP_MS));
  }
});

fbChat.post('/push/outbox/:id/result', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404);
  const result = await parsed(c, parseSendResult);
  if (typeof result === 'string') return c.json(invalid(result), 400);
  const outcome = await getDb(c.env).begin((tx) => recordSendResult(tx, id, result, c.var.oauthCtx.clientId));
  if (outcome === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (outcome === 'not_sending') return c.json({ error: 'not_sending' }, 409);
  kickFbChatTelegram();
  return c.json({ ok: true });
});

fbChat.post('/push/events', async (c) => {
  const push = await parsed(c, parseEventPush);
  if (typeof push === 'string') return c.json(invalid(push), 400);
  await getDb(c.env).begin((tx) => recordEvent(tx, push, c.var.oauthCtx.clientId));
  kickFbChatTelegram();
  return c.json({ ok: true });
});

// The extension's settings page calls this to prove its credentials and to say
// whether replies can arrive at all.
fbChat.get('/push/status', (c) => c.json({ ok: true, telegram: fbChatTelegramConfigured(c.env) }));

// ── Reads (manager) ───────────────────────────────────────────────────────────

fbChat.get('/accounts', async (c) => {
  const rows = await getDb(c.env)`
    SELECT a.id::int AS id, a.fb_uid, a.label, a.ext_version, a.restricted, a.restricted_at, a.last_seen_at,
           (SELECT COUNT(*)::int FROM fb_chat_threads t WHERE t.account_id = a.id) AS threads
      FROM fb_chat_accounts a ORDER BY a.label, a.id`;
  return c.json({ accounts: rows });
});

fbChat.get('/threads', async (c) => {
  const rows = await getDb(c.env)`
    SELECT t.id::int AS id, t.fb_thread_id, a.label AS account, t.buyer_name, t.buyer_location,
           b.rating::float8 AS rating, b.rating_count, b.joined_year,
           t.listing_id, t.listing_title, t.telegram_topic_id, t.last_seq,
           t.last_inbound_at, t.last_outbound_at, t.created_at
      FROM fb_chat_threads t JOIN fb_chat_accounts a ON a.id = t.account_id
      LEFT JOIN fb_chat_buyers b ON b.id = t.buyer_id
     ORDER BY GREATEST(t.last_inbound_at, t.last_outbound_at, t.created_at) DESC LIMIT 500`;
  return c.json({ threads: rows });
});

fbChat.get('/threads/:id/messages', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404);
  const rows = await getDb(c.env)`
    SELECT id::int AS id, seq, direction, source, body, images, backfill, send_state, error, typing_ms,
           tg_user_name, created_at, sent_at
      FROM fb_chat_messages WHERE thread_id = ${id} ORDER BY seq NULLS LAST, id`;
  return c.json({ messages: rows });
});

export default fbChat;
