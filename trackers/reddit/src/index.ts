// Entry point. The same image runs everywhere; ROLE decides whether this
// process polls Reddit (on the VMs) or serves the admin API (next to the
// database).

import {serve} from '@hono/node-server';
import {createAlertSender} from './alerts.ts';
import {createApi} from './api.ts';
import {releaseAllClaims} from './claims.ts';
import {loadConfig} from './config.ts';
import {createDb} from './db.ts';
import {heartbeatOnce, LoopRegistry, removeWorker} from './heartbeat.ts';
import {createLogger} from './logger.ts';
import {evaluateOnce} from './loops/evaluate.ts';
import {notifyOnce} from './loops/notify.ts';
import {pollOnce} from './loops/poll.ts';
import {reactionsOnce} from './loops/reactions.ts';
import {watchOnce} from './loops/watch.ts';
import {startLoop, type LoopHandle} from './loops/runner.ts';
import {RedditPacer} from './pacing.ts';
import {SettingsStore} from './settings.ts';

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

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('shutting down', {signal});
      heartbeat.stop();
      reactions?.stop();
      watch?.stop();
      abort.abort();
      server.close(() => resolve());
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });

  await heartbeat.stopped;
  await reactions?.stopped;
  await watch?.stopped;
  await deregister();
  await sql.end();
}

async function runWorker(): Promise<void> {
  const pacer = new RedditPacer({maxRpm: config.redditMaxRpm});
  const alerts = createAlertSender(config.alertTransport, config.telegramBotToken);

  // Three tickers rather than one sequential pass: Reddit pacing (up to a
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
      })),
    ),
    startHeartbeat('worker'),
  ];

  logger.info('worker started', {
    workerId: config.workerId,
    redditMaxRpm: config.redditMaxRpm,
    alertTransport: config.alertTransport,
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
