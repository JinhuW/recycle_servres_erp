import { Hono, type MiddlewareHandler } from 'hono';
import { isMirror, managerSession, type ManagerEnv } from '../fleet/auth';

// ─── /api/fb-agent ───────────────────────────────────────────────────────────────
// Manager-only. D2 fills in the routes (CONTRACTS §6.7).

const fbAgent = new Hono<ManagerEnv>();

fbAgent.use('*', managerSession);

// A mirror ERP holds a copy of the fleet's database; a write here would land on
// the copy and be lost at the next sync.
const refuseMirrorWrites: MiddlewareHandler<ManagerEnv> = async (c, next) => {
  if (isMirror(c.env) && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'mirror', detail: 'This ERP mirrors the fleet; make the change on the ERP that runs it.' }, 409);
  }
  return next();
};
fbAgent.use('*', refuseMirrorWrites);

export default fbAgent;
