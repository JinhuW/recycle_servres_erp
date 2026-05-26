// Node entry point. Serves the existing Hono app with @hono/node-server,
// injecting an Env built from process.env in place of Cloudflare bindings.
// @hono/node-server otherwise passes Node's req/res as `env`, which would
// shadow our config — so we pass buildEnv() explicitly per request.

import '../scripts/load-env.mjs';
import { serve } from '@hono/node-server';
import app from './index';
import { buildEnv } from './env';
import { getDb } from './db';
import { startFxRefreshLoop } from './lib/fx';

const env = buildEnv();
const port = Number(process.env.PORT ?? 8787);

startFxRefreshLoop(getDb(env));

serve({ fetch: (request) => app.fetch(request, env), port }, (info) => {
  console.log(`recycle-erp-backend listening on :${info.port}`);
});
