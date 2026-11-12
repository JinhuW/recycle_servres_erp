import { Hono, type MiddlewareHandler } from 'hono';
import { authMiddleware } from '../auth';
import { getDb } from '../db';
import { FB_CHAT_CONFIG_KEY, fbChatConfigProblem } from '@recycle-erp/shared';
import {
  FbChatPushError, fbChatConfigValueProblem, parseBuyerPush, parseClaim, parseConfigRequest, parseEventPush,
  parseSendResult, parseSyncPush,
} from '../lib/fbChat';
import { allLimited } from '../lib/concurrency';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { bearerGuard } from '../oauth/guard';
import { claimReply, ingestBuyer, ingestSync, recordEvent, recordSendResult, touchAccount } from '../services/fbChat';
import { configFor, knownFields, notePickup, reportFields, setConfig } from '../services/fbChatConfig';
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

// Each extension asks for its settings about once a minute, bridge on or off,
// and says which fields it understands so the settings page can show them.
fbChat.post('/push/config', async (c) => {
  const req = await parsed(c, parseConfigRequest);
  if (typeof req === 'string') return c.json(invalid(req), 400);
  const answer = await getDb(c.env).begin(async (tx) => {
    await reportFields(tx, req.extVersion, req.fields);
    if (!req.account) return configFor(tx, null);
    const account = await touchAccount(tx, req.account, c.var.oauthCtx.clientId);
    const config = await configFor(tx, account.id);
    await notePickup(tx, account.id, config.rev);
    return config;
  });
  return c.json(answer);
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

// ── Settings (manager) ────────────────────────────────────────────────────────

fbChat.get('/config', async (c) => {
  const sql = getDb(c.env);
  const [fields, entries, accounts] = await allLimited([
    () => knownFields(sql),
    () => sql`
      SELECT c.account_id::int AS account_id, c.key, c.value, c.updated_at, u.name AS updated_by
        FROM fb_chat_config c LEFT JOIN users u ON u.id = c.updated_by
       ORDER BY c.account_id NULLS FIRST, c.key`,
    () => sql<{ id: number; config_rev: string | null }[]>`
      SELECT id::int AS id, fb_uid, label, ext_version, last_seen_at, config_rev, config_seen_at
        FROM fb_chat_accounts ORDER BY label, id`,
  ]);
  // What each profile should have by now, so the page can say whether it has.
  const expected = await allLimited(accounts.map((a) => async () => (await configFor(sql, a.id)).rev), 4);
  return c.json({
    fields,
    entries,
    accounts: accounts.map((a, i) => ({ ...a, expected_rev: expected[i] })),
  });
});

/** The account a settings write names: null for every profile, or a known id. */
function accountParam(v: unknown): number | null | 'bad' {
  if (v === null || v === undefined || v === '') return null;
  const id = Number(v);
  return Number.isSafeInteger(id) && id > 0 ? id : 'bad';
}

fbChat.put('/config/:key', async (c) => {
  const key = c.req.param('key');
  if (!FB_CHAT_CONFIG_KEY.test(key)) return c.json(invalid('not a setting key'), 400);
  const body = await c.req.json().catch(() => null) as { accountId?: unknown; value?: unknown } | null;
  const accountId = accountParam(body?.accountId);
  if (accountId === 'bad') return c.json(invalid('accountId is not an id'), 400);
  const sizeProblem = fbChatConfigValueProblem(body?.value);
  if (sizeProblem) return c.json(invalid(`value ${sizeProblem}`), 400);
  const sql = getDb(c.env);
  // A key no extension reports yet is taken as given, so the ERP can be set
  // ahead of an extension release; one that is reported must fit its field.
  const field = (await knownFields(sql)).find((f) => f.key === key);
  const problem = field ? fbChatConfigProblem(field, body!.value) : null;
  if (problem) return c.json(invalid(`${field!.label} ${problem}`), 400);
  if (accountId !== null) {
    const [known] = await sql`SELECT 1 FROM fb_chat_accounts WHERE id = ${accountId}`;
    if (!known) return c.json({ error: 'not_found' }, 404);
  }
  await setConfig(sql, accountId, key, body!.value, c.var.user.id);
  log.info('fb chat setting changed', { module: 'fbChat', key, accountId });
  return c.json({ ok: true });
});

fbChat.delete('/config/:key', async (c) => {
  const key = c.req.param('key');
  if (!FB_CHAT_CONFIG_KEY.test(key)) return c.json(invalid('not a setting key'), 400);
  const accountId = accountParam(c.req.query('accountId'));
  if (accountId === 'bad') return c.json(invalid('accountId is not an id'), 400);
  await setConfig(getDb(c.env), accountId, key, undefined, c.var.user.id);
  log.info('fb chat setting reset', { module: 'fbChat', key, accountId });
  return c.json({ ok: true });
});

export default fbChat;
