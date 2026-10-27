import { Hono, type Context } from 'hono';
import {
  isFleetTimezone, parseProxyUrl, type FleetProxy, type FleetProxyPatch, type FleetProxyUse,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { poolKey, seal } from '../lib/sealed';
import { managerOnly, unavailable, type ManagerEnv } from './auth';
import { bad, conflict, exists, isRefusal, notFound, type Refusal } from './sql';

// ─── Proxies ──────────────────────────────────────────────────────────────────
// The exits the ERP fleet browses through, as a list a manager keeps. The URL
// holds the vendor login, so it is sealed on the way in and never leaves:
// reads carry host:port, and a slot made on a proxy copies the sealed value
// (fleet_slots.proxy_url is what a claim unseals). Editing a proxy reaches its
// slots at once: a new URL is copied into each, a new timezone into each
// device, and a worker picks either up on its next claim.

const proxies = new Hono<ManagerEnv>().use('*', managerOnly);

const plog = log.child({ module: 'fleet' });
const MAX_LABEL = 80;
const MAX_NOTE = 500;

type ProxyRow = {
  id: number; label: string; url_enc: string; host: string; port: number; timezone: string; note: string; created_at: Date;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every proxy with the slots on it, oldest first. Never selects url_enc. */
export async function listProxies(sql: SqlLike, id?: number): Promise<FleetProxy[]> {
  const rows = await sql<Omit<ProxyRow, 'url_enc'>[]>`
    SELECT id, label, host, port, timezone, note, created_at FROM fleet_proxies
    ${id === undefined ? sql`` : sql`WHERE id = ${id}`} ORDER BY id`;
  const uses = await sql<(FleetProxyUse & { proxy_id: number })[]>`
    SELECT s.proxy_id, s.account_no, a.status AS pool_status,
           (s.lease_expires_at IS NOT DISTINCT FROM 'infinity'::timestamptz) AS parked,
           COALESCE(s.lease_expires_at > NOW() AND s.lease_expires_at <> 'infinity'::timestamptz, FALSE) AS leased
    FROM fleet_slots s JOIN fb_pool_accounts a ON a.no = s.account_no
    WHERE s.proxy_id IS NOT NULL ${id === undefined ? sql`` : sql`AND s.proxy_id = ${id}`}
    ORDER BY s.account_no`;
  return rows.map((r) => ({
    id: r.id, label: r.label, host: r.host, port: r.port, timezone: r.timezone, note: r.note,
    created_at: r.created_at.toISOString(),
    slots: uses.filter((u) => u.proxy_id === r.id)
      .map(({ account_no, pool_status, parked, leased }) => ({ account_no, pool_status, parked, leased })),
  }));
}

type ProxyInput = { label?: string; url?: { text: string; host: string; port: number }; timezone?: string; note?: string };

/** The body of a write; `partial` for an edit, where every key is optional. */
function readProxy(input: unknown, partial: boolean): ProxyInput | Refusal {
  if (!isObject(input)) return bad('expected an object');
  const known = new Set(['label', 'url', 'timezone', 'note']);
  for (const k of Object.keys(input)) if (!known.has(k)) return bad(`not a proxy field: ${k}`);
  const out: ProxyInput = {};
  if (input.label !== undefined || !partial) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > MAX_LABEL) return bad(`label must be 1 to ${MAX_LABEL} characters`);
    out.label = label;
  }
  if (input.url !== undefined || !partial) {
    if (typeof input.url !== 'string') return bad('url is required');
    const parsed = parseProxyUrl(input.url);
    if ('error' in parsed) return bad(parsed.error);
    out.url = { text: input.url.trim(), host: parsed.host, port: parsed.port };
  }
  if (input.timezone !== undefined || !partial) {
    if (!isFleetTimezone(input.timezone)) return bad('timezone must be an IANA zone such as America/New_York');
    out.timezone = input.timezone;
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.length > MAX_NOTE) return bad(`note must be text of at most ${MAX_NOTE} characters`);
    out.note = input.note.trim();
  }
  if (partial && Object.keys(out).length === 0) return bad('nothing to save');
  return out;
}

const refuse = (c: Context, r: Refusal) => c.json(r.body, r.status);
const UNIQUE_VIOLATION = '23505';
const dupe = (host: string, port: number) => exists(`${host}:${port} is already on the list`);

function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

proxies.get('/', async (c) => c.json(await listProxies(getDb(c.env))));

proxies.post('/', async (c) => {
  const input = readProxy(await c.req.json().catch(() => null), false);
  if (isRefusal(input)) return refuse(c, input);
  const key = poolKey(c.env);
  if (!key) return c.json(unavailable('FB_POOL_KEY'), 503);
  const { label, url, timezone, note } = input as Required<Pick<ProxyInput, 'label' | 'url' | 'timezone'>> & ProxyInput;
  const sql = getDb(c.env);
  let id: number;
  try {
    [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO fleet_proxies (label, url_enc, host, port, timezone, note, created_by)
      VALUES (${label}, ${seal(url.text, key)}, ${url.host}, ${url.port}, ${timezone}, ${note ?? ''}, ${c.var.user.id})
      RETURNING id`;
  } catch (e) {
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) return refuse(c, dupe(url.host, url.port));
    throw e;
  }
  plog.info('fleet proxy added', { proxyId: id, exit: `${url.host}:${url.port}`, timezone, by: c.var.user.email });
  const [proxy] = await listProxies(sql, id);
  return c.json(proxy, 201);
});

proxies.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return refuse(c, notFound('proxy'));
  const input = readProxy(await c.req.json().catch(() => null), true) as FleetProxyPatch | Refusal;
  if (isRefusal(input)) return refuse(c, input);
  const patch = input as ProxyInput;
  const key = poolKey(c.env);
  if (patch.url && !key) return c.json(unavailable('FB_POOL_KEY'), 503);
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { slots: number }> => {
    const [cur] = await tx<ProxyRow[]>`SELECT * FROM fleet_proxies WHERE id = ${id} FOR UPDATE`;
    if (!cur) return notFound('proxy');
    const sealed = patch.url ? seal(patch.url.text, key!) : null;
    try {
      await tx.savepoint((sp) => sp`
        UPDATE fleet_proxies SET
          label = ${patch.label ?? cur.label}, timezone = ${patch.timezone ?? cur.timezone}, note = ${patch.note ?? cur.note},
          url_enc = ${sealed ?? cur.url_enc}, host = ${patch.url?.host ?? cur.host}, port = ${patch.url?.port ?? cur.port}
        WHERE id = ${id}`);
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) return dupe(patch.url!.host, patch.url!.port);
      throw e;
    }
    // The slots follow, in the pool-then-slot lock order every slot write takes.
    const nos = (await tx<{ account_no: number }[]>`SELECT account_no FROM fleet_slots WHERE proxy_id = ${id}`).map((r) => r.account_no);
    if (nos.length && (sealed || (patch.timezone && patch.timezone !== cur.timezone))) {
      await tx`SELECT no FROM fb_pool_accounts WHERE no = ANY(${nos}::int[]) ORDER BY no FOR NO KEY UPDATE`;
      await tx`SELECT account_no FROM fleet_slots WHERE account_no = ANY(${nos}::int[]) ORDER BY account_no FOR UPDATE`;
      if (sealed) await tx`UPDATE fleet_slots SET proxy_url = ${sealed} WHERE proxy_id = ${id}`;
      if (patch.timezone && patch.timezone !== cur.timezone) {
        await tx`UPDATE fleet_slots SET device = jsonb_set(device, '{timezone}', to_jsonb(${patch.timezone}::text))
                 WHERE proxy_id = ${id} AND jsonb_typeof(device) = 'object'`;
      }
    }
    return { slots: nos.length };
  });
  if (isRefusal(out)) return refuse(c, out);
  plog.info('fleet proxy updated', {
    proxyId: id, fields: Object.keys(patch), slots: out.slots, by: c.var.user.email,
    ...(patch.url ? { exit: `${patch.url.host}:${patch.url.port}` } : {}),
  });
  const [proxy] = await listProxies(sql, id);
  return c.json(proxy);
});

proxies.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return refuse(c, notFound('proxy'));
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { host: string; port: number }> => {
    const [cur] = await tx<ProxyRow[]>`SELECT * FROM fleet_proxies WHERE id = ${id} FOR UPDATE`;
    if (!cur) return notFound('proxy');
    const busy = await tx<{ account_no: number }[]>`
      SELECT account_no FROM fleet_slots
      WHERE proxy_id = ${id} AND lease_expires_at IS DISTINCT FROM 'infinity'::timestamptz ORDER BY account_no`;
    if (busy.length) {
      return conflict('in_use', `park or remove ${busy.map((b) => `#${b.account_no}`).join(', ')} first`);
    }
    await tx`DELETE FROM fleet_proxies WHERE id = ${id}`;
    return { host: cur.host, port: cur.port };
  });
  if (isRefusal(out)) return refuse(c, out);
  plog.info('fleet proxy removed', { proxyId: id, exit: `${out.host}:${out.port}`, by: c.var.user.email });
  return c.json({ ok: true });
});

export default proxies;
