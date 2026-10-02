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
});

describe('purgeStaleWebSubmissions', () => {
  beforeEach(async () => { await resetDb(); });

  it('drops spam and archived submissions a month old, keeping the rest', async () => {
    const sql = getTestDb();
    for (const [id, status, days] of [
      ['WS-OLD-SPAM', 'spam', 40], ['WS-OLD-ARCH', 'archived', 31],
      ['WS-NEW-SPAM', 'spam', 5], ['WS-OLD-NEW', 'new', 90],
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
    const r = await purgeStaleWebSubmissions(sql, testEnv);
    expect(r).toEqual({ submissions: 2, photos: 1 });
    const left = await sql<{ id: string }[]>`SELECT id FROM web_submissions WHERE id LIKE 'WS-%' ORDER BY id`;
    expect(left.map((x) => x.id)).toEqual(['WS-NEW-SPAM', 'WS-OLD-NEW']);
  });
});
