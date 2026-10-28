import { Hono, type Context } from 'hono';
import { getDb } from '../db';
import { isMirror, managerOnly, managerSession, mirrorGate, type ManagerEnv } from '../fleet/auth';
import {
  createCity, listCities, listItems, loadCity, loadSettings, readCityDraft, readCityPatch, readItems,
  readSettingsPatch, removeCity, saveSettings, updateCity, upsertItems,
} from '../fleet/cities';
import { reconcile } from '../fleet/scheduler';
import { FLEET_TABLES, fleetTablesPresent, isRefusal, type Refusal } from '../fleet/sql';
import { cityLog, funnelDays, listTasks, manualTask, readFunnelDays, readLogQuery, readTaskFilter, startRound } from '../fleet/tasks';
import worker from '../fleet/claim';
import { forwardsReads, mirrorAnswers } from '../fleet/mirror';
import hosts, { releases } from '../fleet/hosts';
import proxies from '../fleet/proxies';
import proxyHealth from '../fleet/proxyHealth';
import { slots, workers } from '../fleet/workers';
import { allowedAppOrigin } from '../lib/origins';
import { VNC_WORKER_ID } from './coordinator';

// ─── Fleet ────────────────────────────────────────────────────────────────────
// The city task queue and the worker slots (src/fleet/). Each sub-module mounts
// its routes here under its own scope: manager routes carry the session cookie
// (managerOnly on each route, not on '*', so a bearer-authed worker or host
// route mounted below is never asked for a cookie), host and worker routes a
// bearer (fleet/auth.ts). Handlers validate, call their module, answer; the
// SQL lives in the module.

const fleet = new Hono<ManagerEnv>();

fleet.use('*', mirrorGate);

const refuse = (c: Context, r: Refusal) => c.json(r.body, r.status);
const body = (c: Context): Promise<unknown> => c.req.json().catch(() => null);

fleet.get('/health', managerOnly, async (c) => {
  const tables = await fleetTablesPresent(getDb(c.env));
  const ok = FLEET_TABLES.every((t) => tables.includes(t));
  // Live only when the fleet's ERP hands over a token: a wrong secret or a
  // revoked client leaves the pages on the copy, and the banner says so.
  const live = isMirror(c.env) && forwardsReads(c.env) && await mirrorAnswers(c.env);
  return c.json({ ok, tables, mirror: isMirror(c.env), mirror_live: live });
});

// ── Catalog: cities, items, settings (fleet/cities.ts) ──────────────────────
// Every write ends with a reconcile so the queue reflects it before the page
// refetches, rather than up to 30 s later on the tick.

fleet.get('/cities', managerOnly, async (c) => c.json({ cities: await listCities(getDb(c.env)) }));

fleet.post('/cities', managerOnly, async (c) => {
  const draft = readCityDraft(await body(c));
  if (isRefusal(draft)) return refuse(c, draft);
  const city = await createCity(getDb(c.env), draft, c.var.user.id);
  if (isRefusal(city)) return refuse(c, city);
  return c.json(city, 201);
});

fleet.put('/cities/:slug', managerOnly, async (c) => {
  const patch = readCityPatch(await body(c));
  if (isRefusal(patch)) return refuse(c, patch);
  const sql = getDb(c.env);
  const slug = c.req.param('slug');
  const city = await updateCity(sql, slug, patch);
  if (isRefusal(city)) return refuse(c, city);
  await reconcile(sql);
  return c.json(await loadCity(sql, slug));
});

fleet.delete('/cities/:slug', managerOnly, async (c) => {
  const sql = getDb(c.env);
  const slug = c.req.param('slug');
  const city = await removeCity(sql, slug);
  if (isRefusal(city)) return refuse(c, city);
  await reconcile(sql);
  return c.json(await loadCity(sql, slug));
});

fleet.get('/items', managerOnly, async (c) => c.json(await listItems(getDb(c.env))));

fleet.put('/items', managerOnly, async (c) => {
  const items = readItems(await body(c));
  if (isRefusal(items)) return refuse(c, items);
  const sql = getDb(c.env);
  const saved = await upsertItems(sql, items);
  await reconcile(sql);
  return c.json(saved);
});

fleet.get('/settings', managerOnly, async (c) => c.json(await loadSettings(getDb(c.env))));

fleet.put('/settings', managerOnly, async (c) => {
  const patch = readSettingsPatch(await body(c));
  if (isRefusal(patch)) return refuse(c, patch);
  const sql = getDb(c.env);
  const saved = await saveSettings(sql, patch, c.var.user.id);
  await reconcile(sql);
  return c.json(saved);
});

// ── Tasks: list, log, search now, round start (fleet/tasks.ts) ──────────────

fleet.get('/tasks', managerOnly, async (c) => {
  const filter = readTaskFilter(c.req.query());
  if (isRefusal(filter)) return refuse(c, filter);
  const { tasks, truncated } = await listTasks(getDb(c.env), filter);
  if (truncated) c.header('X-Fleet-Truncated', 'true');
  return c.json(tasks);
});

fleet.post('/tasks', managerOnly, async (c) => {
  const raw = await body(c);
  const city = typeof (raw as { city?: unknown })?.city === 'string' ? (raw as { city: string }).city : '';
  const item = typeof (raw as { item?: unknown })?.item === 'string' ? (raw as { item: string }).item : '';
  if (!city || !item) return c.json({ error: 'bad_request', detail: 'city and item are required' }, 422);
  const task = await manualTask(getDb(c.env), city, item);
  if (isRefusal(task)) return refuse(c, task);
  return c.json(task, 201);
});

fleet.post('/round/start', managerOnly, async (c) => c.json(await startRound(getDb(c.env))));

// The Analysis tab's search-to-alert counts, from the fleet's finished tasks.
fleet.get('/stats/funnel', managerOnly, async (c) => {
  const days = readFunnelDays(c.req.query());
  if (isRefusal(days)) return refuse(c, days);
  return c.json({ days: await funnelDays(getDb(c.env), days) });
});

fleet.get('/city-log', managerOnly, async (c) => {
  const q = readLogQuery(c.req.query());
  if (isRefusal(q)) return refuse(c, q);
  return c.json(await cityLog(getDb(c.env), q));
});

// ── Slots, hosts, workers, the worker protocol ───────────────────────────────
// Each module mounts its own scope: claim is hostAuth, the rest of the worker
// protocol workerAuth (fleet/claim.ts); hosts carry managerOnly on the list
// and hostAuth on desired/report (fleet/hosts.ts); slots and workers are the
// manager's (fleet/workers.ts), and so are the proxies (fleet/proxies.ts) and
// their health (fleet/proxyHealth.ts).

fleet.route('/worker', worker);
fleet.route('/hosts', hosts);
fleet.route('/releases', releases);
fleet.route('/slots', slots);
fleet.route('/workers', workers);
fleet.route('/proxies/health', proxyHealth);
fleet.route('/proxies', proxies);

// The manager's end of a fleet worker's VNC relay (fleet/vnc.ts). Like the
// coordinator path, the handshake is replayed here as a GET so the session,
// the role and the Origin are checked before a socket exists.
fleet.get('/vnc/:workerId/ws', managerSession, (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
  }
  if (!allowedAppOrigin(c.req.header('origin'), c.env.CORS_ALLOWED_ORIGINS)) {
    return c.json({ error: 'Origin not allowed' }, 403);
  }
  if (!VNC_WORKER_ID.test(c.req.param('workerId'))) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

export default fleet;
