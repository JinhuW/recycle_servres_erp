// Entry point. The same image runs everywhere; ROLE decides whether this
// process polls Reddit (on the VMs) or serves the admin API (next to the
// database).

import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {createAlertSender} from './alerts.ts';
import {createApi} from './api.ts';
import {releaseAllClaims} from './claims.ts';
import {loadConfig} from './config.ts';
import {createDb} from './db.ts';
import {heartbeatOnce, LoopRegistry, removeWorker} from './heartbeat.ts';
import {createLogger} from './logger.ts';
import {evaluateOnce} from './loops/evaluate.ts';
import {acquireUserSender, notifyOnce, releaseUserSender, renewUserSender} from './loops/notify.ts';
import {pollOnce} from './loops/poll.ts';
import {reactionsOnce} from './loops/reactions.ts';
import {readsOnce} from './loops/reads.ts';
import {Tracer} from './loops/trace.ts';
import {watchOnce} from './loops/watch.ts';
import {startLoop, type LoopHandle} from './loops/runner.ts';
import {RedditPacer} from './pacing.ts';
import {SettingsStore} from './settings.ts';
import {connectUserClient, createUserFirstSender, type UserClient, type UserCredentials} from './userSender.ts';

const config = loadConfig();
const registry = new LoopRegistry();
// Every warn/error line goes to the registry too: it is how a failing loop is
// noticed and what the ops watch sends on (loops/watch.ts).
const logger = createLogger(
  config.workerId, config.logLevel, undefined,
  (scope, level, message, fields) => registry.noteProblem(scope, level, message, fields),
);
const sql = createDb(config.databaseUrl);
const settings = new SettingsStore(sql);
const startedAt = Date.now();

const HEARTBEAT_IDLE_MS = 30_000;

function startHeartbeat(role: 'worker' | 'api'): LoopHandle {
  return startLoop(
    {name: 'heartbeat', logger: logger.child('heartbeat'), idleMs: HEARTBEAT_IDLE_MS},
    () => heartbeatOnce({
      sql,
      workerId: config.workerId,
      role,
      startedAt: new Date(startedAt),
      registry,
    }),
  );
}

/** Clean shutdown deletes our fleet row; a crash leaves it to go stale. */
async function deregister(): Promise<void> {
  try {
    await removeWorker(sql, config.workerId);
  } catch (e) {
    logger.warn('could not remove worker row on shutdown', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

let shuttingDown = false;

async function main(): Promise<void> {
  if (config.role === 'api') {
    await runApi();
    return;
  }
  await runWorker();
}

async function runApi(): Promise<void> {
  const app = createApi({
    sql,
    settings,
    botToken: config.telegramBotToken,
    apiToken: config.apiToken,
    workerId: config.workerId,
    startedAt,
  });

  const server = serve({fetch: app.fetch, port: config.apiPort});
  logger.info('api listening', {port: config.apiPort});
  const heartbeat = startHeartbeat('api');

  // The api is the one single-copy service, so it is the one that may poll
  // the bot's updates (see loops/reactions.ts). Console mode means "not the
  // real Telegram", which keeps a local api off production's updates. Not
  // registered with the heartbeat: its loop names are part of the ERP's
  // /api/workers contract.
  const abort = new AbortController();
  const reactions = config.alertTransport === 'telegram'
    ? startLoop(
      // The long poll is the wait; the idle pause only spaces out failures.
      {name: 'reactions', logger: logger.child('reactions'), idleMs: 5_000},
      () => reactionsOnce({
        sql,
        botToken: config.telegramBotToken,
        settings,
        logger: logger.child('reactions'),
        signal: abort.signal,
      }),
    )
    : null;

  // Like the reactions loop, the watch must run once per fleet, so it lives in
  // the api. Off without a relay to send to (local runs).
  const watch = config.opsAlertUrl
    ? startLoop(
      {name: 'watch', logger: logger.child('watch'), idleMs: 60_000, busyMs: 5_000},
      () => watchOnce({
        sql,
        // Without the problem hook: a relay failure in worker_errors would be
        // queued for the relay that just failed, and pad the digest after it.
        logger: createLogger(config.workerId, config.logLevel, 'watch'),
        selfId: config.workerId,
        relayUrl: config.opsAlertUrl,
        relayToken: config.opsAlertToken,
      }),
    )
    : null;
  if (!watch) logger.info('ops alerts off: OPS_ALERT_URL is not set');

  const stopping = new Promise<string>((resolve) => {
    process.once('SIGTERM', () => resolve('SIGTERM'));
    process.once('SIGINT', () => resolve('SIGINT'));
  });

  // With a user session, buyer alerts go out from here as that account, and
  // their read receipts come back here; the workers stand down while it is
  // live (loops/notify.ts). A session that will not connect leaves the
  // workers sending through the bot, as before.
  const owner = `${config.workerId}:${randomUUID()}`;
  let user: UserClient | null = null;
  if (config.telegramUser && config.alertTransport === 'telegram') {
    user = await connectWhenFree(config.telegramUser, owner, stopping);
  }
  const userLoops = user ? [
    startLoop(
      {name: 'user-notify', logger: logger.child('notify'), idleMs: 10_000, busyMs: 500},
      async () => {
        if (!await renewUserSender(sql, owner)) {
          logger.warn('another api holds the telegram user session; not sending as the user');
          return false;
        }
        return notifyOnce({
          sql,
          workerId: config.workerId,
          alerts: createUserFirstSender(user!, createAlertSender('telegram', config.telegramBotToken)),
          settings,
          logger: logger.child('notify'),
        });
      },
    ),
    startLoop(
      {name: 'reads', logger: logger.child('reads'), idleMs: 5 * 60_000},
      () => readsOnce({sql, user: user!, settings, logger: logger.child('reads')}),
    ),
  ] : [];

  const signal = await stopping;
  shuttingDown = true;
  logger.info('shutting down', {signal});
  heartbeat.stop();
  reactions?.stop();
  watch?.stop();
  for (const loop of userLoops) loop.stop();
  abort.abort();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await heartbeat.stopped;
  await reactions?.stopped;
  await watch?.stopped;
  await Promise.all(userLoops.map((l) => l.stopped));
  if (user) {
    // Disconnect before releasing: the next api connects the moment the
    // hold clears.
    await user.disconnect();
    await releaseUserSender(sql, owner);
  }
  await deregister();
  await sql.end();
}

const USER_SESSION_WAIT_MS = 5_000;

/**
 * Waits until no other api holds the user session (a redeploy's outgoing
 * copy), then connects. Null if the session will not connect, or if this
 * process is told to stop first.
 */
async function connectWhenFree(
  creds: UserCredentials,
  owner: string,
  stopping: Promise<string>,
): Promise<UserClient | null> {
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  let waiting = false;
  while (!stopped) {
    try {
      if (await acquireUserSender(sql, owner)) break;
    } catch (e) {
      logger.warn('could not take the telegram user session', {error: e instanceof Error ? e.message : String(e)});
    }
    if (!waiting) logger.info('another api holds the telegram user session; waiting for it to let go');
    waiting = true;
    await Promise.race([stopping, new Promise((r) => setTimeout(r, USER_SESSION_WAIT_MS))]);
  }
  if (stopped) return null;
  try {
    return await connectUserClient(creds, logger.child('user'));
  } catch (e) {
    logger.warn('telegram user session did not connect; the bot keeps sending alerts', {
      error: e instanceof Error ? e.message : String(e),
    });
    await releaseUserSender(sql, owner).catch(() => {});
    return null;
  }
}

async function runWorker(): Promise<void> {
  const pacer = new RedditPacer({maxRpm: config.redditMaxRpm});
  const alerts = createAlertSender(config.alertTransport, config.telegramBotToken);

  // Separate tickers rather than one sequential pass: Reddit pacing (up to a
  // minute of waiting) must never hold up LLM evaluation or alerting, and a
  // failing LLM must not stop post discovery.
  const loops: LoopHandle[] = [
    startLoop(
      {name: 'poll', logger: logger.child('poll'), idleMs: 15_000, busyMs: 1_000},
      registry.wrap('poll', () => pollOnce({
        sql,
        workerId: config.workerId,
        userAgent: config.redditUserAgent,
        pacer,
        settings,
        logger: logger.child('poll'),
      })),
    ),
    startLoop(
      {name: 'evaluate', logger: logger.child('evaluate'), idleMs: 10_000, busyMs: 500},
      registry.wrap('evaluate', () => evaluateOnce({
        sql,
        workerId: config.workerId,
        apiKey: config.openrouterApiKey,
        settings,
        alerts,
        logger: logger.child('evaluate'),
      })),
    ),
    startLoop(
      {name: 'notify', logger: logger.child('notify'), idleMs: 10_000, busyMs: 500},
      registry.wrap('notify', () => notifyOnce({
        sql,
        workerId: config.workerId,
        alerts,
        settings,
        logger: logger.child('notify'),
        deferToUserSender: true,
      })),
    ),
    startHeartbeat('worker'),
  ];
  if (config.commentTracer) {
    // Idle mostly means another worker holds the lease; checking every minute
    // is how this one notices the holder is gone.
    const tracer = new Tracer({
      sql,
      workerId: config.workerId,
      userAgent: config.redditUserAgent,
      pacer,
      logger: logger.child('trace'),
    });
    loops.push(startLoop(
      {name: 'trace', logger: logger.child('trace'), idleMs: 60_000, busyMs: 1_000},
      registry.wrap('trace', () => tracer.once()),
    ));
  }

  logger.info('worker started', {
    workerId: config.workerId,
    redditMaxRpm: config.redditMaxRpm,
    alertTransport: config.alertTransport,
    commentTracer: config.commentTracer,
  });

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutting down', {signal});
      for (const loop of loops) loop.stop();
      resolve();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });

  await Promise.all(loops.map((l) => l.stopped));

  // Hand work back immediately instead of making the fleet wait out the claim
  // TTL. A hard kill still recovers, just five minutes slower.
  try {
    await releaseAllClaims(sql, config.workerId);
  } catch (e) {
    logger.warn('could not release claims on shutdown', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  await deregister();
  await sql.end();
  logger.info('worker stopped');
}

try {
  await main();
} catch (e) {
  logger.error('fatal', {error: e instanceof Error ? e.stack ?? e.message : String(e)});
  await sql.end().catch(() => {});
  process.exit(1);
}
