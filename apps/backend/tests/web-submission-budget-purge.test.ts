import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { purgeStaleWebSubmissions } from '../src/lib/webSubmissionPurge';

const quote = {
  customer_type: 'business', hardware: ['Servers'], quantity: '11-50',
  condition: 'working', data_handling: 'wipe', pickup_method: 'pickup', origin_zip: '80216',
  timeline: 'within-30', name: 'Dana Ops', company: 'Acme DC', email: 'dana@acme.example',
  phone: '(303) 555-0100', notes: 'Two racks',
};
const send = () => api<{ ref?: string; error?: string }>('POST', '/api/public/quote', {
  body: quote, headers: { 'X-Requested-By': '', 'X-Client-IP': `198.51.100.${Math.floor(Math.random() * 200)}` },
});

describe('public form daily budget', () => {
  beforeEach(async () => { await resetDb(); });

  // The per-address limit stops one sender; this stops many senders at once.
  it('429s once the day has had its quota, with the wait until midnight UTC', async () => {
    await getTestDb()`
      INSERT INTO workspace_settings (key, value) VALUES ('public_form_daily_submissions', '1'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    expect((await send()).status).toBe(201);
    const r = await send();
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  // Pacing under the per-minute limit, one sender would otherwise use up the
  // whole day's budget by itself.
  it('gives one address its own daily share, and only when the Worker named it', async () => {
    const sql = getTestDb();
    for (let i = 0; i < 20; i++) {
      await sql`
        INSERT INTO web_submissions (id, site, kind, email, payload, ip)
        VALUES (${`WS-PACE-${i}`}, 'recycleservers', 'quote', 'x@example.com', '{}'::jsonb, '203.0.113.50')
      `;
    }
    const from = (headers: Record<string, string>) =>
      api('POST', '/api/public/quote', { body: quote, headers: { 'X-Requested-By': '', ...headers } });
    expect((await from({ 'X-Client-IP': '203.0.113.50' })).status).toBe(429);
    expect((await from({ 'X-Client-IP': '203.0.113.51' })).status).toBe(201);
    // Without X-Client-IP every caller shares a Cloudflare address.
    expect((await from({ 'X-Forwarded-For': '203.0.113.50' })).status).toBe(201);
  });

  // An IPv6 subscriber holds a whole /64; counted per address, rotating
  // through it was a fresh share every time.
  it('counts an IPv6 sender by its /64', async () => {
    const sql = getTestDb();
    for (let i = 0; i < 19; i++) {
      await sql`
        INSERT INTO web_submissions (id, site, kind, email, payload, ip, ip_key)
        VALUES (${`WS-V6-${i}`}, 'recycleservers', 'quote', 'x@example.com', '{}'::jsonb,
                ${`2001:db8:1:2::${i + 1}`}, '2001:db8:1:2::/64')
      `;
    }
    const from = (ip: string) =>
      api<{ ref?: string }>('POST', '/api/public/quote', { body: quote, headers: { 'X-Requested-By': '', 'X-Client-IP': ip } });
    const twentieth = await from('2001:db8:1:2::abcd');
    expect(twentieth.status).toBe(201);
    const [row] = await sql<{ ip: string; ip_key: string }[]>`
      SELECT ip, ip_key FROM web_submissions WHERE id = ${twentieth.body.ref!}`;
    expect(row).toEqual({ ip: '2001:db8:1:2::abcd', ip_key: '2001:db8:1:2::/64' });
    expect((await from('2001:db8:1:2::ffff')).status).toBe(429);
    expect((await from('2001:db8:1:3::1')).status).toBe(201);
  });
});

describe('purgeStaleWebSubmissions', () => {
  beforeEach(async () => { await resetDb(); });

  it('drops spam and archived submissions a month old, keeping the rest', async () => {
    const sql = getTestDb();
    for (const [id, status, days] of [
      ['WS-OLD-SPAM', 'spam', 40], ['WS-OLD-ARCH', 'archived', 31],
      ['WS-NEW-SPAM', 'spam', 5], ['WS-OLD-NEW', 'new', 90], ['WS-OLD-CONV', 'archived', 60],
    ] as const) {
      await sql`
        INSERT INTO web_submissions (id, site, kind, email, payload, status, updated_at)
        VALUES (${id}, 'ram4cash', 'quote', 'x@example.com', '{}'::jsonb, ${status},
                NOW() - make_interval(days => ${days}))
      `;
    }
    await sql`
      INSERT INTO web_submission_photos (submission_id, line_index, position, filename, size_bytes, mime_type, storage_key, delivery_url)
      VALUES ('WS-OLD-SPAM', 0, 0, 'a.jpg', 10, 'image/jpeg', 'stub-a', 'stub://a')
    `;
    // Converted, then archived by hand to clear the inbox: it is the PO's
    // record of who sold the lot, so it stays.
    await sql`UPDATE web_submissions SET order_id = (SELECT id FROM orders LIMIT 1) WHERE id = 'WS-OLD-CONV'`;
    const r = await purgeStaleWebSubmissions(sql, testEnv);
    expect(r).toMatchObject({ submissions: 2, photos: 1, scanned: 2 });
    const left = await sql<{ id: string }[]>`SELECT id FROM web_submissions WHERE id LIKE 'WS-%' ORDER BY id`;
    expect(left.map((x) => x.id)).toEqual(['WS-NEW-SPAM', 'WS-OLD-CONV', 'WS-OLD-NEW']);
  });

  // Without R2 the delete call reports success for keys it never touched, so
  // dropping the row would strand the object.
  it('keeps a row whose photo is a real R2 object when R2 is not configured', async () => {
    const sql = getTestDb();
    await sql`
      INSERT INTO web_submissions (id, site, kind, email, payload, status, updated_at)
      VALUES ('WS-OLD-REAL', 'ram4cash', 'quote', 'x@example.com', '{}'::jsonb, 'spam',
              NOW() - make_interval(days => 40))
    `;
    await sql`
      INSERT INTO web_submission_photos (submission_id, line_index, position, filename, size_bytes, mime_type, storage_key, delivery_url)
      VALUES ('WS-OLD-REAL', 0, 0, 'a.jpg', 10, 'image/jpeg', 'web/real-key', 'https://r2.example/web/real-key')
    `;
    // testEnv carries no R2 credentials.
    const r = await purgeStaleWebSubmissions(sql, testEnv);
    expect(r).toMatchObject({ submissions: 0, scanned: 1, lastId: 'WS-OLD-REAL' });
    const after = await purgeStaleWebSubmissions(sql, testEnv, { afterId: 'WS-OLD-REAL' });
    expect(after.scanned).toBe(0);
  });
});
