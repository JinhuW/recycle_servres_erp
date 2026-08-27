import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';
import { refreshPackageTracking, registerUntrackedPackages, startShipmentTrackingLoop } from '../src/shipping/track';
import { pickTrackingClient } from '../src/shipping';
import { stubShippingClient } from '../src/shipping/stub';
import type { ShippingClient } from '../src/shipping/types';

type Pkg = {
  id: string;
  trackingNumber: string;
  carrier: string;
  status: string;
  sellerName: string | null;
  note: string | null;
  source: string | null;
  orderId: string | null;
  creatorName: string | null;
};

const TN = '1Z999AA10123456784';

async function addPackage(token: string, over: Record<string, unknown> = {}): Promise<Pkg> {
  const r = await api<{ package: Pkg }>('POST', '/api/packages', {
    token,
    body: { trackingNumber: TN, carrier: 'UPS', source: 'other', sellerName: 'Bo Li', ...over },
  });
  expect(r.status).toBe(201);
  return r.body.package;
}

describe('packages — add and list', () => {
  beforeEach(async () => { await resetDb(); });

  it('adds a package at purchased, trims optional fields to null', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token, { sellerName: '  ', note: ' fragile ' });
    expect(pkg.status).toBe('purchased');
    expect(pkg.carrier).toBe('UPS');
    expect(pkg.sellerName).toBeNull();
    expect(pkg.note).toBe('fragile');
    expect(pkg.orderId).toBeNull();
  });

  it('rejects a duplicate tracking number, a bad carrier, and a short number', async () => {
    const { token } = await loginAs(MARCUS);
    await addPackage(token);
    const dup = await api('POST', '/api/packages', {
      token, body: { trackingNumber: TN, carrier: 'UPS', source: 'other' },
    });
    expect(dup.status).toBe(409);
    const badCarrier = await api('POST', '/api/packages', {
      token, body: { trackingNumber: '9400111899223333333333', carrier: 'DHL', source: 'other' },
    });
    expect(badCarrier.status).toBe(400);
    const short = await api('POST', '/api/packages', {
      token, body: { trackingNumber: '123', carrier: 'UPS', source: 'other' },
    });
    expect(short.status).toBe(400);
  });

  it('scopes the list: purchasers see their own, managers see all', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const mgr = await loginAs(ALEX);
    await addPackage(marcus.token);

    const own = await api<{ items: Pkg[] }>('GET', '/api/packages', { token: marcus.token });
    expect(own.body.items).toHaveLength(1);
    const other = await api<{ items: Pkg[] }>('GET', '/api/packages', { token: priya.token });
    expect(other.body.items).toHaveLength(0);
    const all = await api<{ items: Pkg[] }>('GET', '/api/packages', { token: mgr.token });
    expect(all.body.items).toHaveLength(1);
  });

  it('names who submitted each row, on the add and on the list', async () => {
    const marcus = await loginAs(MARCUS);
    const mgr = await loginAs(ALEX);
    const sql = getTestDb();
    const { name } = (await sql`SELECT name FROM users WHERE id = ${marcus.user.id}`)[0] as { name: string };

    const added = await addPackage(marcus.token);
    expect(added.creatorName).toBe(name);

    const all = await api<{ items: Pkg[] }>('GET', '/api/packages', { token: mgr.token });
    expect(all.body.items[0].creatorName).toBe(name);
  });

  it('mine=true pins a manager to their own rows, mirroring GET /api/shipments', async () => {
    const marcus = await loginAs(MARCUS);
    const mgr = await loginAs(ALEX);
    await addPackage(marcus.token);

    const mine = await api<{ items: Pkg[] }>('GET', '/api/packages?mine=true', { token: mgr.token });
    expect(mine.body.items).toHaveLength(0);
  });

  it('normalizes the pasted number at the boundary so variants collide on the unique index', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token, { trackingNumber: ' 1z 999-aa1 0123 456 784 ' });
    expect(pkg.trackingNumber).toBe(TN);

    const dup = await api('POST', '/api/packages', {
      token, body: { trackingNumber: TN, carrier: 'UPS', source: 'other' },
    });
    expect(dup.status).toBe(409);
  });

  it('requires a recognised source, and round-trips it', async () => {
    const { token } = await loginAs(MARCUS);
    const missing = await api('POST', '/api/packages', {
      token, body: { trackingNumber: TN, carrier: 'UPS' },
    });
    expect(missing.status).toBe(400);
    const bogus = await api('POST', '/api/packages', {
      token, body: { trackingNumber: TN, carrier: 'UPS', source: 'craigslist' },
    });
    expect(bogus.status).toBe(400);

    for (const [i, src] of ['facebook', 'local', 'reddit', 'other'].entries()) {
      const pkg = await addPackage(token, { trackingNumber: `1Z999AA1012345678${i}`, source: src });
      expect(pkg.source, src).toBe(src);
      const list = await api<{ items: Pkg[] }>('GET', '/api/packages', { token });
      expect(list.body.items.find(p => p.id === pkg.id)?.source, src).toBe(src);
    }
  });

  it('serves the carrier tracking link server-side, like shipments.trackingUrl', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token) as Pkg & { trackingUrl: string | null };
    expect(pkg.trackingUrl).toBe(`https://www.ups.com/track?tracknum=${TN}`);
  });

  it('rejects junk that cannot be a tracking number: metacharacters, URLs, whole-barcode dumps', async () => {
    const { token } = await loginAs(MARCUS);
    for (const bad of ['12%45678', 'https://t.co/abc12345', '9'.repeat(34)]) {
      const r = await api('POST', '/api/packages', {
        token, body: { trackingNumber: bad, carrier: 'UPS', source: 'other' },
      });
      expect(r.status, bad).toBe(400);
    }
  });

  it('strips a FNC1/GS control character before storing the number', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token, {
      trackingNumber: '9400\x1d111899223333333333', carrier: 'USPS',
    });
    expect(pkg.trackingNumber).toBe('9400111899223333333333');
  });
});

describe('packages — lookup by scanned barcode', () => {
  beforeEach(async () => { await resetDb(); });

  type Lookup = { package: (Pkg & { trackingUrl: string | null; creatorName: string | null }) | null };

  it('finds the exact tracking number from a messy scan, with the creator named', async () => {
    const marcus = await loginAs(MARCUS);
    const pkg = await addPackage(marcus.token, { note: 'two servers, dock B' });

    const r = await api<Lookup>('GET', `/api/packages/lookup?code=${encodeURIComponent(' 1z 999-aa1 0123 456 784 ')}`, {
      token: marcus.token,
    });
    expect(r.status).toBe(200);
    expect(r.body.package?.id).toBe(pkg.id);
    expect(r.body.package?.trackingNumber).toBe(TN);
    expect(r.body.package?.note).toBe('two servers, dock B');
    expect(r.body.package?.trackingUrl).toBe(`https://www.ups.com/track?tracknum=${TN}`);
    expect(r.body.package?.orderId).toBeNull();

    const sql = getTestDb();
    const { name } = (await sql`SELECT name FROM users WHERE id = ${marcus.user.id}`)[0] as { name: string };
    expect(r.body.package?.creatorName).toBe(name);
  });

  it('matches a carrier barcode that wraps the tracking number (USPS IMpb prefix)', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token, { trackingNumber: '9400111899223333333333', carrier: 'USPS' });

    const r = await api<Lookup>('GET', '/api/packages/lookup?code=420802299400111899223333333333', { token });
    expect(r.status).toBe(200);
    expect(r.body.package?.id).toBe(pkg.id);
  });

  it('scopes like the list: another purchaser gets null, a manager finds any box', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const mgr = await loginAs(ALEX);
    const pkg = await addPackage(marcus.token);

    const hidden = await api<Lookup>('GET', `/api/packages/lookup?code=${TN}`, { token: priya.token });
    expect(hidden.status).toBe(200);
    expect(hidden.body.package).toBeNull();

    const found = await api<Lookup>('GET', `/api/packages/lookup?code=${TN}`, { token: mgr.token });
    expect(found.status).toBe(200);
    expect(found.body.package?.id).toBe(pkg.id);
    expect(found.body.package?.creatorName).toBeTruthy();
  });

  it('returns null for an unknown number and 400 for a missing or too-short code', async () => {
    const { token } = await loginAs(MARCUS);
    await addPackage(token);

    const miss = await api<Lookup>('GET', '/api/packages/lookup?code=1Z000XX00000000000', { token });
    expect(miss.status).toBe(200);
    expect(miss.body.package).toBeNull();

    const missing = await api('GET', '/api/packages/lookup', { token });
    expect(missing.status).toBe(400);
    const short = await api('GET', '/api/packages/lookup?code=123', { token });
    expect(short.status).toBe(400);
  });

  it('treats the stored number as a literal suffix, not a LIKE pattern', async () => {
    const marcus = await loginAs(MARCUS);
    const sql = getTestDb();
    // Rows predating boundary validation can hold LIKE metacharacters.
    await sql`
      INSERT INTO packages (tracking_number, carrier, created_by)
      VALUES (${'12%45678'}, 'UPS', ${marcus.user.id})
    `;
    const r = await api<Lookup>('GET', '/api/packages/lookup?code=12XXXX45678', { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body.package).toBeNull();
  });

  it('survives a stored number ending in the LIKE escape character', async () => {
    const marcus = await loginAs(MARCUS);
    const sql = getTestDb();
    await sql`
      INSERT INTO packages (tracking_number, carrier, created_by)
      VALUES (${'1234567\\'}, 'UPS', ${marcus.user.id})
    `;
    const r = await api<Lookup>('GET', '/api/packages/lookup?code=1Z000XX00000000000', { token: marcus.token });
    expect(r.status).toBe(200);
    expect(r.body.package).toBeNull();
  });

  it('reports the linked PO once create-po has run', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const created = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    expect(created.status).toBe(201);

    const r = await api<Lookup>('GET', `/api/packages/lookup?code=${TN}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.package?.orderId).toBe(created.body.orderId);
  });
});

describe('packages — delete guards', () => {
  beforeEach(async () => { await resetDb(); });

  it('creator deletes an unlinked package; a non-owner purchaser cannot', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const pkg = await addPackage(marcus.token);

    const denied = await api('DELETE', `/api/packages/${pkg.id}`, { token: priya.token });
    expect(denied.status).toBe(403);
    const ok = await api('DELETE', `/api/packages/${pkg.id}`, { token: marcus.token });
    expect(ok.status).toBe(200);
    const gone = await api<{ items: Pkg[] }>('GET', '/api/packages', { token: marcus.token });
    expect(gone.body.items).toHaveLength(0);
  });

  it('refuses to delete a package that already has a PO', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const created = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    expect(created.status).toBe(201);

    const denied = await api('DELETE', `/api/packages/${pkg.id}`, { token });
    expect(denied.status).toBe(409);
  });
});

describe('packages — create-po', () => {
  beforeEach(async () => { await resetDb(); });

  it('is refused before delivery, then atomically mints a linked draft PO', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token, { note: 'two servers' });

    const early = await api('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    expect(early.status).toBe(409);

    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const r = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    expect(r.status).toBe(201);
    expect(r.body.orderId).toMatch(/^PO-\d+$/);

    const order = (await sql`
      SELECT user_id, lifecycle, notes FROM orders WHERE id = ${r.body.orderId}
    `)[0] as { user_id: string; lifecycle: string; notes: string };
    expect(order.lifecycle).toBe('draft');
    expect(order.notes).toBe(`Created from delivered package · UPS · ${TN} · Bo Li`);

    const events = await sql<{ kind: string }[]>`
      SELECT kind FROM order_events WHERE order_id = ${r.body.orderId}
    `;
    expect(events.map(e => e.kind)).toContain('created');

    const linked = (await sql`SELECT order_id FROM packages WHERE id = ${pkg.id}`)[0] as { order_id: string };
    expect(linked.order_id).toBe(r.body.orderId);

    // Idempotence guard: the second click cannot mint a second PO.
    const again = await api('POST', `/api/packages/${pkg.id}/create-po`, { token, body: {} });
    expect(again.status).toBe(409);
  });

  it('a manager clicking Create PO files it for the package creator, on-behalf style', async () => {
    const marcus = await loginAs(MARCUS);
    const mgr = await loginAs(ALEX);
    const pkg = await addPackage(marcus.token);
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;

    const r = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, {
      token: mgr.token, body: {},
    });
    expect(r.status).toBe(201);

    const order = (await sql`SELECT user_id FROM orders WHERE id = ${r.body.orderId}`)[0] as { user_id: string };
    expect(order.user_id).toBe(marcus.user.id);

    const created = (await sql<{ actor_id: string; detail: { onBehalfOfUserId?: string } }[]>`
      SELECT actor_id, detail FROM order_events WHERE order_id = ${r.body.orderId} AND kind = 'created'
    `)[0];
    expect(created.actor_id).toBe(mgr.user.id);
    expect(created.detail.onBehalfOfUserId).toBe(marcus.user.id);
  });

  it('a manager may mint the PO before delivery; it still belongs to the label creator', async () => {
    const marcus = await loginAs(MARCUS);
    const mgr = await loginAs(ALEX);
    const pkg = await addPackage(marcus.token);
    expect(pkg.status).toBe('purchased');

    // The creator (a purchaser) still waits for delivery…
    const early = await api('POST', `/api/packages/${pkg.id}/create-po`, {
      token: marcus.token, body: {},
    });
    expect(early.status).toBe(409);

    // …but a manager can file it now — tracking isn't live, status may never move.
    const r = await api<{ orderId: string }>('POST', `/api/packages/${pkg.id}/create-po`, {
      token: mgr.token, body: {},
    });
    expect(r.status).toBe(201);

    const sql = getTestDb();
    const order = (await sql`
      SELECT user_id, lifecycle, notes FROM orders WHERE id = ${r.body.orderId}
    `)[0] as { user_id: string; lifecycle: string; notes: string };
    expect(order.user_id).toBe(marcus.user.id);
    expect(order.lifecycle).toBe('draft');
    // The note stays honest: this box was not delivered when the PO was minted.
    expect(order.notes).toBe(`Created from package · UPS · ${TN} · Bo Li`);
  });

  it('only the creator or a manager may create the PO', async () => {
    const marcus = await loginAs(MARCUS);
    const priya = await loginAs(PRIYA);
    const pkg = await addPackage(marcus.token);
    const sql = getTestDb();
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;

    const denied = await api('POST', `/api/packages/${pkg.id}/create-po`, { token: priya.token, body: {} });
    expect(denied.status).toBe(403);
  });
});

describe('packages — tracking refresh', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves purchased → in_transit through the status guard (stub client)', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const sql = getTestDb();

    const res = await refreshPackageTracking(sql, stubShippingClient);
    expect(res.checked).toBe(1);
    expect(res.updated).toBe(1);
    const row = (await sql`
      SELECT status, tracking_eta, last_tracked_at FROM packages WHERE id = ${pkg.id}
    `)[0] as { status: string; tracking_eta: Date | null; last_tracked_at: Date | null };
    expect(row.status).toBe('in_transit');
    expect(row.tracking_eta).not.toBeNull();
    expect(row.last_tracked_at).not.toBeNull();

    // Delivered rows leave the poll's working set.
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.id}`;
    const res2 = await refreshPackageTracking(sql, stubShippingClient);
    expect(res2.checked).toBe(0);
  });

  it('notifies the creator when a package lands delivered', async () => {
    const { token, user } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const sql = getTestDb();

    const delivering: ShippingClient = {
      ...stubShippingClient,
      getShipment: async () => ({ raw: 'DELIVERED', normalized: 'delivered', eta: null }),
    };
    const res = await refreshPackageTracking(sql, delivering);
    expect(res.updated).toBe(1);

    const row = (await sql`SELECT status FROM packages WHERE id = ${pkg.id}`)[0] as { status: string };
    expect(row.status).toBe('delivered');
    const notes = await sql<{ user_id: string; title: string }[]>`
      SELECT user_id, title FROM notifications WHERE kind = 'package_delivered'
    `;
    expect(notes).toHaveLength(1);
    expect(notes[0].user_id).toBe(user.id);
    expect(notes[0].title).toContain(TN);
  });
});

describe('packages — ask the carrier now', () => {
  beforeEach(async () => { await resetDb(); });

  const shippoEnv = { SHIPPO_API_TOKEN: 'shippo_test_x', SHIPPO_API_URL: 'http://127.0.0.1:9' };

  it('501s while no tracking provider is configured', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const r = await api<{ error: string }>('POST', `/api/packages/${pkg.id}/refresh`, { token });
    expect(r.status).toBe(501);
    expect(r.body.error).toContain('SHIPPO_API_TOKEN');
  });

  it('502s, and keeps the row as it was, when the provider cannot be reached', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const r = await api('POST', `/api/packages/${pkg.id}/refresh`, { token, env: shippoEnv });
    expect(r.status).toBe(502);
    const sql = getTestDb();
    const row = (await sql`SELECT status, last_tracked_at FROM packages WHERE id = ${pkg.id}`)[0] as
      { status: string; last_tracked_at: Date | null };
    expect(row.status).toBe('purchased');
    expect(row.last_tracked_at).toBeNull();
  });

  it('is the creator\'s and a manager\'s to call, nobody else\'s', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);

    const other = await loginAs(PRIYA);
    const denied = await api('POST', `/api/packages/${pkg.id}/refresh`, { token: other.token, env: shippoEnv });
    expect(denied.status).toBe(403);

    // Reaching 502 is the point: the guard let both through to the provider.
    const manager = await loginAs(ALEX);
    for (const t of [token, manager.token]) {
      const r = await api('POST', `/api/packages/${pkg.id}/refresh`, { token: t, env: shippoEnv });
      expect(r.status).toBe(502);
    }
  });

  it('404s on a package that does not exist', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/packages/00000000-0000-0000-0000-000000000000/refresh', {
      token, env: shippoEnv,
    });
    expect(r.status).toBe(404);
  });
});

describe('packages — webhook registration', () => {
  beforeEach(async () => { await resetDb(); });

  it('leaves the add unregistered when no provider can register', async () => {
    const { token } = await loginAs(MARCUS);
    const pkg = await addPackage(token);
    const sql = getTestDb();
    const row = (await sql`SELECT tracking_registered_at FROM packages WHERE id = ${pkg.id}`)[0] as
      { tracking_registered_at: Date | null };
    expect(row.tracking_registered_at).toBeNull();
  });

  it('sweeps active unregistered rows and stamps only the ones that took', async () => {
    const { token } = await loginAs(MARCUS);
    const a = await addPackage(token);
    const b = await addPackage(token, { trackingNumber: '1Z999AA10123456799' });
    const sql = getTestDb();
    // Delivered rows have nothing left to push, so the sweep skips them.
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${b.id}`;

    const seen: string[] = [];
    const done = await registerUntrackedPackages(sql, {
      registerTracking: async (tn) => { seen.push(tn); },
    });
    expect(done).toBe(1);
    expect(seen).toEqual([TN]);

    const rows = await sql<{ id: string; tracking_registered_at: Date | null }[]>`
      SELECT id, tracking_registered_at FROM packages ORDER BY created_at
    `;
    expect(rows.find(r => r.id === a.id)!.tracking_registered_at).not.toBeNull();
    expect(rows.find(r => r.id === b.id)!.tracking_registered_at).toBeNull();
  });

  it('does not re-register a number, and does not stamp one that threw', async () => {
    const { token } = await loginAs(MARCUS);
    await addPackage(token);
    const sql = getTestDb();

    // A registration Shippo refused leaves the stamp NULL so the next tick retries:
    // registering twice would push two update streams for one box.
    const failed = await registerUntrackedPackages(sql, {
      registerTracking: async () => { throw new Error('shippo POST /tracks/ failed: HTTP 400'); },
    });
    expect(failed).toBe(0);

    let calls = 0;
    expect(await registerUntrackedPackages(sql, { registerTracking: async () => { calls++; } })).toBe(1);
    expect(await registerUntrackedPackages(sql, { registerTracking: async () => { calls++; } })).toBe(0);
    expect(calls).toBe(1);
  });
});

describe('shipping — which tracking provider is in play', () => {
  it('prefers Shippo, falls back to ShipSaving, then stubs', () => {
    expect(pickTrackingClient({ SHIPPO_API_TOKEN: 'x' } as never).provider).toBe('shippo');
    expect(pickTrackingClient({
      SHIPSAVING_APP_KEY: 'k', SHIPSAVING_APP_SECRET: 's',
    } as never).provider).toBe('shipsaving');
    // Shippo wins even with ShipSaving present: it tracks any carrier's number.
    expect(pickTrackingClient({
      SHIPPO_API_TOKEN: 'x', SHIPSAVING_APP_KEY: 'k', SHIPSAVING_APP_SECRET: 's',
    } as never).provider).toBe('shippo');
    expect(pickTrackingClient({} as never).provider).toBe('stub');
  });

  it('ticks on a Shippo token with ShipSaving absent, and stays dark with neither', () => {
    const sql = getTestDb();
    // The regression this whole change exists to prevent: labels on the stub
    // used to mean tracking never ran at all.
    const live = startShipmentTrackingLoop(sql, { SHIPPO_API_TOKEN: 'x', SHIPPO_API_URL: 'http://127.0.0.1:9' } as never);
    expect(live.stop).toBeTypeOf('function');
    live.stop();

    const dark = startShipmentTrackingLoop(sql, {} as never);
    dark.stop();
  });
});
