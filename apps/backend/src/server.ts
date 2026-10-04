// Node entry point. Serves the existing Hono app with @hono/node-server,
// injecting an Env built from process.env in place of Cloudflare bindings.
// @hono/node-server otherwise passes Node's req/res as `env`, which would
// shadow our config — so we pass buildEnv() explicitly per request.

import '../scripts/load-env.mjs';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import app from './index';
import { buildEnv } from './env';
import { closeSharedDb, getDb } from './db';
import { startFxRefreshLoop } from './lib/fx';
import { log } from './lib/log';
import { onShutdown } from './lib/shutdown';
import { startPackageTrackingLoop } from './shipping/track';
import { startBankSyncLoop } from './banktx/sync';
import { startWebSubmissionPurgeLoop } from './lib/webSubmissionPurge';
import { attachVncBridge, closeVncBridges } from './vncBridge';

const env = buildEnv();
const port = Number(process.env.PORT ?? 8787);

const loops = [
  startFxRefreshLoop(getDb(env)),
  startPackageTrackingLoop(getDb(env), env),
  startBankSyncLoop(env),
  startWebSubmissionPurgeLoop(getDb(env), env),
];

const server = serve({ fetch: (request) => app.fetch(request, env), port }, (info) => {
  log.info('recycle-erp-backend listening', { port: info.port });
});

// The only WebSocket the backend serves: the Facebook fleet's VNC viewer,
// relayed to the rs-console facade (see vncBridge.ts).
attachVncBridge(server as Server, app, env);

// Railway sends SIGKILL when its draining window ends, so hardMs has to stay
// under that window for the exit to be ours. It is the backend service's
// `drainingSeconds`, set to 30 on prod and dev.
const shutdown = onShutdown({
  server: server as Server,
  loops,
  closeDb: closeSharedDb,
  graceMs: 20_000,
  hardMs: 25_000,
});
// A relayed VNC socket never ends on its own, and an upgraded socket is no
// longer an HTTP connection closeAllConnections() can cut — so the viewers are
// told to go first, and server.close() is not left waiting on them.
process.once('SIGTERM', () => { closeVncBridges(); void shutdown('SIGTERM'); });
process.once('SIGINT', () => { closeVncBridges(); void shutdown('SIGINT'); });
