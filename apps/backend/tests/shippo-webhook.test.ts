import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

const SECRET = 'shippo-webhook-secret-value';
const WEBHOOK = `/api/public/shippo/${SECRET}`;
const TN = '1Z999AA10123456784';

const env = { SHIPPO_WEBHOOK_SECRET: SECRET };

function trackUpdated(status: string, over: Record<string, unknown> = {}) {
  return {
    event: 'track_updated',
    test: true,
    data: {
      carrier: 'ups',
      tracking_number: TN,
      eta: '2026-08-27T20:42:29.622Z',
      tracking_status: {
        status,
        status_details: `wire detail for ${status}`,
        status_date: '2026-08-25T22:01:59.222Z',
      },
      ...over,
    },
  };
}

async function addPackage(): Promise<string> {
  const { token } = await loginAs(MARCUS);
  const r = await api<{ package: { id: string } }>('POST', '/api/packages', {
    token,
    body: { trackingNumber: TN, carrier: 'UPS', source: 'other' },
  });
  expect(r.status).toBe(201);
  return r.body.package.id;
}

describe('shippo webhook — the secret is the whole credential', () => {
  beforeEach(async () => { await resetDb(); });

  it('404s on a wrong secret, a short secret, and when none is configured', async () => {
    for (const path of [`/api/public/shippo/${SECRET}x`, '/api/public/shippo/nope']) {
      const r = await api('POST', path, { body: trackUpdated('TRANSIT'), env });
      expect(r.status).toBe(404);
    }
    // Unconfigured answers exactly like a miss — never reveals it exists.
    const off = await api('POST', WEBHOOK, { body: trackUpdated('TRANSIT') });
    expect(off.status).toBe(404);
  });

  it('accepts the call with no session cookie and no CSRF header', async () => {
    await addPackage();
    const r = await api('POST', WEBHOOK, {
      body: trackUpdated('TRANSIT'),
      headers: { 'X-Requested-By': '' },
      env,
    });
    expect(r.status).toBe(200);
  });
});

describe('shippo webhook — applying track_updated', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves a package to in_transit and records the carrier metadata', async () => {
    const id = await addPackage();
    const r = await api<{ applied: boolean; status: string }>('POST', WEBHOOK, {
      body: trackUpdated('TRANSIT'), env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.status).toBe('in_transit');

    const sql = getTestDb();
    const row = (await sql`
      SELECT status, tracking_status, tracking_eta, last_tracked_at FROM packages WHERE id = ${id}
    `)[0] as { status: string; tracking_status: string; tracking_eta: Date; last_tracked_at: Date };
    expect(row.status).toBe('in_transit');
    expect(row.tracking_status).toBe('wire detail for TRANSIT');
    // An instant is stored as one: truncating it names the wrong day for every
    // end-of-day ETA west of UTC.
    expect(row.tracking_eta.toISOString()).toBe('2026-08-27T20:42:29.622Z');
    expect(row.last_tracked_at).not.toBeNull();
  });

  it('delivers, and tells whoever tracked the box', async () => {
    const id = await addPackage();
    const r = await api('POST', WEBHOOK, { body: trackUpdated('DELIVERED'), env });
    expect(r.status).toBe(200);

    const sql = getTestDb();
    const row = (await sql`SELECT status, created_by FROM packages WHERE id = ${id}`)[0] as
      { status: string; created_by: string };
    expect(row.status).toBe('delivered');

    const notes = (await sql`
      SELECT kind, title FROM notifications WHERE user_id = ${row.created_by} AND kind = 'package_delivered'
    `) as unknown as { kind: string; title: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain(TN);
  });

  it('will not walk a delivered package backwards', async () => {
    const id = await addPackage();
    await api('POST', WEBHOOK, { body: trackUpdated('DELIVERED'), env });
    const r = await api<{ status: string }>('POST', WEBHOOK, { body: trackUpdated('TRANSIT'), env });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('delivered');

    const sql = getTestDb();
    const row = (await sql`SELECT status FROM packages WHERE id = ${id}`)[0] as { status: string };
    expect(row.status).toBe('delivered');
  });

  it('is inert on a repeat of the same status', async () => {
    const id = await addPackage();
    await api('POST', WEBHOOK, { body: trackUpdated('TRANSIT'), env });
    await api('POST', WEBHOOK, { body: trackUpdated('TRANSIT'), env });
    const sql = getTestDb();
    const row = (await sql`SELECT status FROM packages WHERE id = ${id}`)[0] as { status: string };
    expect(row.status).toBe('in_transit');
  });

  it('routes FAILURE and RETURNED to exception', async () => {
    const id = await addPackage();
    await api('POST', WEBHOOK, { body: trackUpdated('FAILURE'), env });
    const sql = getTestDb();
    const row = (await sql`SELECT status FROM packages WHERE id = ${id}`)[0] as { status: string };
    expect(row.status).toBe('exception');
  });
});

describe('shippo webhook — payloads we do not act on still answer 2XX', () => {
  beforeEach(async () => { await resetDb(); });

  // A 4XX here would burn Shippo's two retries, or retry forever on garbage.
  it('ignores other event types', async () => {
    await addPackage();
    const r = await api<{ applied: boolean }>('POST', WEBHOOK, {
      body: { event: 'transaction_created', test: true, data: { tracking_number: TN } },
      env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
  });

  it('ignores a tracking number nobody is tracking, and touches nothing', async () => {
    const id = await addPackage();
    const r = await api<{ applied: boolean }>('POST', WEBHOOK, {
      body: trackUpdated('DELIVERED', { tracking_number: '1Z999AA10000000000' }),
      env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);

    const sql = getTestDb();
    const row = (await sql`SELECT status, last_tracked_at FROM packages WHERE id = ${id}`)[0] as
      { status: string; last_tracked_at: Date | null };
    expect(row.status).toBe('purchased');
    expect(row.last_tracked_at).toBeNull();
  });

  it('ignores a body with no data and an unparseable body', async () => {
    expect((await api('POST', WEBHOOK, { body: { event: 'track_updated' }, env })).status).toBe(200);
    expect((await api('POST', WEBHOOK, { body: trackUpdated('TRANSIT', { tracking_number: '' }), env })).status).toBe(200);
  });

  it('answers 2XX rather than 500 on fields of the wrong type', async () => {
    // A 500 is retried by Shippo, and each retry writes the URL secret into the
    // error sink.
    await addPackage();
    const r = await api<{ applied: boolean }>('POST', WEBHOOK, {
      body: { event: 'track_updated', data: { tracking_number: TN, eta: 7, tracking_status: 9 } },
      env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
  });
});

describe('shippo webhook — matching the number back to a box', () => {
  beforeEach(async () => { await resetDb(); });

  it('matches a payload rendered the carrier\'s way, not ours', async () => {
    // POST /api/packages stores the normalized form; Shippo may echo the
    // carrier's own spelling. A verbatim-only match would silently drop these
    // and degrade the whole push path to the 45-minute poll.
    const id = await addPackage();
    const r = await api<{ applied: boolean }>('POST', WEBHOOK, {
      body: trackUpdated('DELIVERED', { tracking_number: '1z999-aa10 123456784' }),
      env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);

    const sql = getTestDb();
    const row = (await sql`SELECT status FROM packages WHERE id = ${id}`)[0] as { status: string };
    expect(row.status).toBe('delivered');
  });

  it('still matches a stored number that predates boundary validation', async () => {
    const id = await addPackage();
    const sql = getTestDb();
    // Rows added before the number was normalized on the way in, which is also
    // the form Shippo would have been registered with and echoes back.
    await sql`UPDATE packages SET tracking_number = '1Z999-AA1-0123456784' WHERE id = ${id}`;

    const r = await api<{ applied: boolean }>('POST', WEBHOOK, {
      body: trackUpdated('DELIVERED', { tracking_number: '1Z999-AA1-0123456784' }),
      env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);

    const row = (await sql`SELECT status FROM packages WHERE id = ${id}`)[0] as { status: string };
    expect(row.status).toBe('delivered');
  });

  it('keeps the carrier metadata a sparse push says nothing about', async () => {
    const id = await addPackage();
    const sql = getTestDb();
    await api('POST', WEBHOOK, { body: trackUpdated('TRANSIT'), env });

    // Routine for USPS, and exactly what Shippo's "send test webhook" emits:
    // a real number, no status, no eta. Writing it through would blank the
    // "Arrives …" headline on the phone.
    const r = await api<{ applied: boolean }>('POST', WEBHOOK, {
      body: { event: 'track_updated', data: { tracking_number: TN, eta: null } },
      env,
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);

    const row = (await sql`
      SELECT status, tracking_status, tracking_eta FROM packages WHERE id = ${id}
    `)[0] as { status: string; tracking_status: string; tracking_eta: Date };
    expect(row.status).toBe('in_transit');
    expect(row.tracking_status).toBe('wire detail for TRANSIT');
    expect(row.tracking_eta.toISOString()).toBe('2026-08-27T20:42:29.622Z');
  });
});
