import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('POST /api/market/:id/manual-price', () => {
  let managerToken: string;
  let managerId: string;
  let purchaserToken: string;
  let refPriceId: string;

  beforeAll(async () => {
    await resetDb();
    const m = await loginAs(ALEX);
    managerToken = m.token;
    managerId = m.user.id;
    purchaserToken = (await loginAs(MARCUS)).token;
    const sql = getTestDb();
    refPriceId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices ORDER BY id LIMIT 1`)[0].id;
  });

  it('200 — manager records a price; row + event update', async () => {
    const sql = getTestDb();
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: 123.45, note: 'wing called' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { lastPrice: number; lastPriceAt: string };
    expect(body.lastPrice).toBe(123.45);
    expect(typeof body.lastPriceAt).toBe('string');

    const rp = (await sql<{ last_price: number; last_price_source: string }[]>`
      SELECT last_price::float AS last_price, last_price_source
      FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(123.45);
    expect(rp.last_price_source).toBe(`manual:${ALEX}`);

    const ev = (await sql<{ price: number; source: string; note: string | null; actor_user_id: string | null }[]>`
      SELECT price::float AS price, source, note, actor_user_id
      FROM ref_price_events
      WHERE ref_price_id = ${refPriceId}
      ORDER BY created_at DESC LIMIT 1
    `)[0];
    expect(ev.price).toBe(123.45);
    expect(ev.source).toBe(`manual:${ALEX}`);
    expect(ev.note).toBe('wing called');
    expect(ev.actor_user_id).toBe(managerId);
  });

  it('403 — purchaser is rejected and writes nothing', async () => {
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: purchaserToken,
      body: { price: 10 },
    });
    expect(r.status).toBe(403);
    const after = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    expect(after).toBe(before);
  });

  it('400 — negative price', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: -5 },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_price');
  });

  it('400 — non-finite price', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: 'abc' as unknown as number },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_price');
  });

  it('400 — note longer than 280 chars', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: 50, note: 'x'.repeat(281) },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('note_too_long');
  });

  it('404 — unknown id', async () => {
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;
    const r = await api('POST', '/api/market/00000000-0000-0000-0000-000000000000/manual-price', {
      token: managerToken,
      body: { price: 1 },
    });
    expect(r.status).toBe(404);
    const after = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;
    expect(after).toBe(before);
  });

  it('403 — missing CSRF header', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      headers: { 'X-Requested-By': '' },
      body: { price: 50 },
    });
    expect(r.status).toBe(403);
  });

  it('two sequential POSTs append two distinct events', async () => {
    const sql = getTestDb();
    const beforeC = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    const r1 = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken, body: { price: 80 },
    });
    const r2 = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken, body: { price: 90 },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const afterC = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    expect(afterC).toBe(beforeC + 2);
    const rp = (await sql<{ last_price: number }[]>`
      SELECT last_price::float AS last_price FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(90);
  });
});
