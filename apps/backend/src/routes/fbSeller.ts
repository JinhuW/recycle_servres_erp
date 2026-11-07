import { Hono, type MiddlewareHandler } from 'hono';
import { isMirror, managerSession, type ManagerEnv } from '../fleet/auth';

// ─── /api/fb-seller ───────────────────────────────────────────────────────────────
// Manager-only. C fills in the routes (CONTRACTS §5.1).

const fbSeller = new Hono<ManagerEnv>();

fbSeller.use('*', managerSession);

// A mirror ERP holds a copy of the fleet's database; a write here would land on
// the copy and be lost at the next sync.
const refuseMirrorWrites: MiddlewareHandler<ManagerEnv> = async (c, next) => {
  if (isMirror(c.env) && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'mirror', detail: 'This ERP mirrors the fleet; make the change on the ERP that runs it.' }, 409);
  }
  return next();
};
fbSeller.use('*', refuseMirrorWrites);

export default fbSeller;
