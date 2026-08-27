// Shippo track_updated receiver, mounted at /api/public/shippo/:secret.
//
// CSRF-exempt and unauthenticated like the rest of /api/public/* (see csrf.ts
// and the auth allowlist in index.ts) — the secret in the URL is the whole
// credential, vendor-portal style. Shippo publishes no signature or HMAC
// header, so there is nothing else to verify against; the secret has to be
// long and random, and rotating it means updating the Shippo dashboard too.
//
// In production Shippo must be pointed at the public hostname, not the Railway
// origin: the Cloudflare Worker is what injects X-Proxy-Secret past the origin
// lockdown.

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Env, User } from '../types';
import { getDb } from '../db';
import { trackToInfo } from '../shipping/shippo';
import { applyPackageTracking, type TrackedPackageRow } from '../shipping/track';

const shippoWebhook = new Hono<{ Bindings: Env; Variables: { user: User } }>();

function secretMatches(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would leak length by
  // status code — compare lengths first and still run the constant-time check.
  return a.length === b.length && timingSafeEqual(a, b);
}

shippoWebhook.post('/:secret', async (c) => {
  // A miss and an unconfigured secret answer identically: the endpoint never
  // reveals whether it exists.
  if (!secretMatches(c.req.param('secret'), c.env.SHIPPO_WEBHOOK_SECRET)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { event?: string; test?: boolean; data?: Record<string, unknown> }
    | null;
  // Everything below answers 2XX. Shippo wants one within ~3s and retries on
  // 5XX/408/429 — a 4XX for a payload we simply don't care about would burn
  // those retries and, for unparseable bodies, retry forever.
  if (body?.event !== 'track_updated' || !body.data) return c.json({ ok: true, applied: false });

  const trackingNumber = typeof body.data.tracking_number === 'string' ? body.data.tracking_number : '';
  if (!trackingNumber) return c.json({ ok: true, applied: false });

  const sql = getDb(c.env);
  // Packages only. Shippo pushes for numbers we registered with it, and only
  // packages are registered — shipments carry ShipSaving's own labels and stay
  // on the poll.
  const row = (await sql`
    SELECT id, status, tracking_number, carrier, created_by
    FROM packages
    WHERE tracking_number = ${trackingNumber}
    LIMIT 1
  `)[0] as TrackedPackageRow | undefined;
  if (!row) return c.json({ ok: true, applied: false });

  const next = await applyPackageTracking(sql, row, trackToInfo(body.data));
  return c.json({ ok: true, applied: true, status: next ?? row.status });
});

export default shippoWebhook;
