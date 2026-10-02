import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// The per-IP limiter is module state shared by every test in this file, so
// each request speaks from its own address; the 429 test is the only one that
// repeats one.
let ipSeq = 0;
const ip = () => `203.0.113.${++ipSeq % 250}`;
const headers = (extra: Record<string, string> = {}) => ({ 'X-Forwarded-For': ip(), ...extra });

function jpeg(name = 'label.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' });
}

const ramLine = {
  category: 'RAM', qty: 24,
  fields: { classification: 'RDIMM', capacity: '32GB', speed: '2933', rank: '2Rx4', brand: 'Samsung', part_number: 'M393A4K40CB2-CVF' },
};
const ssdLine = {
  category: 'SSD', qty: 6,
  fields: { brand: 'Samsung', capacity: '960GB', interface: 'SATA', form_factor: '2.5"', part_number: 'MZ7LH960HAJR' },
};
const cpuLine = {
  category: 'CPU', qty: 2,
  fields: { brand: 'Intel', description: 'Xeon Gold 6248R', part_number: 'SRGZG' },
};
const quote = {
  customer_type: 'business', hardware: ['Servers', 'Networking'], quantity: '11-50',
  condition: 'working', data_handling: 'wipe', pickup_method: 'pickup', origin_zip: '80216',
  timeline: 'within-30', name: 'Dana Ops', company: 'Acme DC', email: 'Dana@Acme.example',
  phone: '(303) 555-0100', notes: 'Two racks of R740s',
};

type Ref = { ref: string | null; lines?: number; units?: number; error?: string };

// Public endpoints: no cookie, and deliberately no X-Requested-By — the CSRF
// guard exempts /api/public/*, and a browser on another origin can't send it.
function submit(body: unknown, h: Record<string, string> = {}) {
  return api<Ref>('POST', '/api/public/intake', { body, headers: headers({ 'X-Requested-By': '', ...h }) });
}
function submitQuote(body: unknown, h: Record<string, string> = {}) {
  return api<Ref>('POST', '/api/public/quote', { body, headers: headers({ 'X-Requested-By': '', ...h }) });
}

describe('POST /api/public/intake', () => {
  beforeEach(async () => { await resetDb(); });

  it('stores a JSON lot as a submission, tells managers, and creates no PO', async () => {
    const before = (await getTestDb()`SELECT COUNT(*)::int AS n FROM orders`)[0].n;
    const r = await submit({ email: 'Seller@Example.com', notes: 'Pulled from an R740', source: 'web', lines: [ramLine, ssdLine] });
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(/^WS-\d+$/);
    expect(r.body.lines).toBe(2);
    expect(r.body.units).toBe(30);

    const sql = getTestDb();
    const [w] = await sql`SELECT * FROM web_submissions WHERE id = ${r.body.ref!}`;
    expect(w).toMatchObject({
      site: 'ram4cash', kind: 'sell_lot', status: 'new', email: 'seller@example.com',
      notes: 'Pulled from an R740', source: 'web', order_id: null,
    });
    expect(w.payload.handoff).toBe('ship');
    expect(w.payload.lines).toHaveLength(2);
    expect((await sql`SELECT COUNT(*)::int AS n FROM orders`)[0].n).toBe(before);

    const notes = await sql`
      SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.kind = 'web_submission' AND u.role = 'manager'
    `;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].title).toContain(r.body.ref!);
  });

  it('keeps multipart photos by line', async () => {
    const payload = JSON.stringify({ email: 'photos@example.com', source: 'web', lines: [{ category: 'RAM', qty: 1, fields: {} }, ssdLine] });
    const r = await multipart('/api/public/intake', {
      payload, 'photo-0-0': jpeg('a.jpg'), 'photo-0-1': jpeg('b.jpg'), 'photo-1-0': jpeg('c.jpg'),
    }, { headers: headers({ 'X-Requested-By': '' }) });
    expect(r.status).toBe(201);
    const ref = (r.body as Ref).ref!;
    const photos = await getTestDb()`
      SELECT line_index, filename, position FROM web_submission_photos
      WHERE submission_id = ${ref} ORDER BY line_index, position
    `;
    expect(photos.map(p => [p.line_index, p.filename, p.position])).toEqual([[0, 'a.jpg', 0], [0, 'b.jpg', 1], [1, 'c.jpg', 0]]);
  });

  it('refuses a non-image photo with 415', async () => {
    const payload = JSON.stringify({ email: 'bad@example.com', source: 'web', lines: [ramLine] });
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'x.pdf', { type: 'application/pdf' });
    const r = await multipart('/api/public/intake', { payload, 'photo-0-0': pdf },
      { headers: headers({ 'X-Requested-By': '' }) });
    expect(r.status).toBe(415);
  });

  it('400s on bad input and writes nothing', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ email: 'nope', source: 'web', lines: [ramLine] }, /email/],
      [{ email: 'a@b.co', source: 'web', lines: [] }, /at least one line/],
      [{ email: 'a@b.co', source: 'web', lines: [{ category: 'GPU', qty: 1, fields: {} }] }, /category/],
      [{ email: 'a@b.co', source: 'web', lines: [{ category: 'RAM', qty: 0, fields: {} }] }, /qty/],
      [{ email: 'a@b.co', source: 'web', lines: [{ category: 'RAM', qty: 1, fields: { brand: 'Samsung' } }] }, /photo or at least/],
      [{ email: 'a@b.co', source: 'web', handoff: 'pickup', lines: [ramLine] }, /pickup city/],
    ];
    for (const [body, msg] of cases) {
      const r = await submit(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    expect(await getTestDb()`SELECT 1 FROM web_submissions`).toHaveLength(0);
  });

  it('swallows a filled honeypot without writing', async () => {
    const r = await submit({ email: 'bot@example.com', website: 'http://spam', source: 'web', lines: [ramLine] });
    expect(r.status).toBe(200);
    expect(r.body.ref).toBeNull();
    expect(await getTestDb()`SELECT 1 FROM web_submissions`).toHaveLength(0);
  });

  it('429s the sixth submission from one address inside a minute, with Retry-After', async () => {
    const addr = '198.51.100.7';
    for (let i = 0; i < 5; i++) {
      const r = await submit({ email: `s${i}@example.com`, source: 'web', lines: [ramLine] }, { 'X-Forwarded-For': addr });
      expect(r.status).toBe(201);
    }
    const r = await submitQuote(quote, { 'X-Forwarded-For': addr });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('does not throttle the rest of /api/public', async () => {
    const addr = '198.51.100.8';
    for (let i = 0; i < 6; i++) {
      const r = await api('GET', '/api/public/shippo/not-a-secret', { headers: { 'X-Forwarded-For': addr } });
      expect(r.status).not.toBe(429);
    }
  });
});

describe('POST /api/public/quote', () => {
  beforeEach(async () => { await resetDb(); });

  it('stores a quote request', async () => {
    const r = await submitQuote(quote);
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(/^WS-\d+$/);
    const [w] = await getTestDb()`SELECT * FROM web_submissions WHERE id = ${r.body.ref!}`;
    expect(w).toMatchObject({
      site: 'recycleservers', kind: 'quote', name: 'Dana Ops', company: 'Acme DC',
      email: 'dana@acme.example', phone: '(303) 555-0100', notes: 'Two racks of R740s',
    });
    expect(w.payload.hardware).toEqual(['Servers', 'Networking']);
    expect(w.payload.origin_zip).toBe('80216');
  });

  it('400s on bad input', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...quote, name: '' }, /name/],
      [{ ...quote, email: 'x' }, /email/],
      [{ ...quote, company: '' }, /company/],
      [{ ...quote, hardware: [] }, /hardware/],
      [{ ...quote, phone: 'call me' }, /phone/],
    ];
    for (const [body, msg] of cases) {
      const r = await submitQuote(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    // An individual needs no company.
    const ok = await submitQuote({ ...quote, customer_type: 'individual', company: '' });
    expect(ok.status).toBe(201);
  });
});

describe('/api/web-submissions (manager)', () => {
  beforeEach(async () => { await resetDb(); });

  it('lists with filters, counts, and keyset paging; purchasers get 403', async () => {
    const lot = await submit({ email: 'lot@example.com', source: 'reddit', lines: [ramLine] });
    const q = await submitQuote(quote);
    const { token } = await loginAs(ALEX);

    type List = { items: { id: string; site: string }[]; nextCursor: string | null; counts: Record<string, number> };
    const all = await api<List>('GET', '/api/web-submissions', { token });
    expect(all.status).toBe(200);
    expect(all.body.items.map(i => i.id)).toEqual([q.body.ref, lot.body.ref]);
    expect(all.body.counts.new).toBe(2);

    const site = await api<List>('GET', '/api/web-submissions?site=recycleservers', { token });
    expect(site.body.items.map(i => i.id)).toEqual([q.body.ref]);
    const search = await api<List>('GET', '/api/web-submissions?q=acme', { token });
    expect(search.body.items.map(i => i.id)).toEqual([q.body.ref]);

    const p1 = await api<List>('GET', '/api/web-submissions?limit=1', { token });
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await api<List>('GET', `/api/web-submissions?limit=1&cursor=${p1.body.nextCursor}`, { token });
    expect(p2.body.items.map(i => i.id)).toEqual([lot.body.ref]);
    expect(p2.body.nextCursor).toBeNull();

    const purchaser = await loginAs(MARCUS);
    expect((await api('GET', '/api/web-submissions', { token: purchaser.token })).status).toBe(403);
    expect((await api('GET', `/api/web-submissions/${lot.body.ref}`, { token: purchaser.token })).status).toBe(403);
  });

  it('shows one submission with photos and triages it', async () => {
    const payload = JSON.stringify({ email: 'p@example.com', source: 'web', lines: [ramLine] });
    const r = await multipart('/api/public/intake', { payload, 'photo-0-0': jpeg('a.jpg') },
      { headers: headers({ 'X-Requested-By': '' }) });
    const ref = (r.body as Ref).ref!;
    const { token, user } = await loginAs(ALEX);

    type One = { submission: { status: string; staffNote: string | null; photos: { lineIndex: number; filename: string }[]; handledBy: { id: string } | null } };
    const one = await api<One>('GET', `/api/web-submissions/${ref}`, { token });
    expect(one.status).toBe(200);
    expect(one.body.submission.photos).toMatchObject([{ lineIndex: 0, filename: 'a.jpg' }]);

    const patched = await api<One>('PATCH', `/api/web-submissions/${ref}`, { token, body: { status: 'contacted', staffNote: 'Emailed offer' } });
    expect(patched.status).toBe(200);
    expect(patched.body.submission).toMatchObject({ status: 'contacted', staffNote: 'Emailed offer', handledBy: { id: user.id } });

    expect((await api('PATCH', `/api/web-submissions/${ref}`, { token, body: { status: 'converted' } })).status).toBe(400);
    expect((await api('PATCH', `/api/web-submissions/${ref}`, { token, body: { status: 'bogus' } })).status).toBe(400);
    expect((await api('GET', '/api/web-submissions/WS-1', { token })).status).toBe(404);
  });

  it('converts a shipped lot into a PayPal Draft PO with copied photos, once', async () => {
    const payload = JSON.stringify({ email: 'Seller@Example.com', notes: 'Pulled from an R740', source: 'web', lines: [ramLine, cpuLine] });
    const r = await multipart('/api/public/intake', { payload, 'photo-0-0': jpeg('a.jpg') },
      { headers: headers({ 'X-Requested-By': '' }) });
    const ref = (r.body as Ref).ref!;
    const { token, user } = await loginAs(ALEX);

    const conv = await api<{ orderId: string; submission: { status: string; orderId: string } }>(
      'POST', `/api/web-submissions/${ref}/convert`, { token });
    expect(conv.status).toBe(201);
    expect(conv.body.orderId).toMatch(/^PO-\d+$/);
    expect(conv.body.submission).toMatchObject({ status: 'converted', orderId: conv.body.orderId });

    const sql = getTestDb();
    const [po] = await sql`
      SELECT o.lifecycle, o.user_id, o.payment, o.payment_method, o.handoff_method,
             o.commission_rate::float AS commission_rate, o.source, o.notes,
             s.email AS supplier_email, s.source AS supplier_source, s.owner_id AS supplier_owner
      FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ${conv.body.orderId}
    `;
    expect(po).toMatchObject({
      lifecycle: 'draft', user_id: user.id, payment: 'company', payment_method: 'paypal',
      handoff_method: null, commission_rate: 0, source: 'other',
      supplier_email: 'seller@example.com', supplier_source: 'web', supplier_owner: null,
    });
    expect(po.notes).toContain(ref);
    expect(po.notes).toContain('Pulled from an R740');

    const lines = await sql`
      SELECT category, item_type, type, part_number, qty, unit_cost::float AS unit_cost, condition
      FROM order_lines WHERE order_id = ${conv.body.orderId} ORDER BY position
    `;
    expect(lines).toMatchObject([
      { category: 'RAM', type: 'Server', part_number: 'M393A4K40CB2-CVF', qty: 24, unit_cost: 0, condition: 'Pulled — Untested' },
      { category: 'Other', item_type: 'CPU', part_number: 'SRGZG', qty: 2 },
    ]);

    const [src] = await sql`SELECT storage_key FROM web_submission_photos WHERE submission_id = ${ref}`;
    const poPhotos = await sql`SELECT filename, storage_key FROM order_line_photos WHERE order_id = ${conv.body.orderId}`;
    expect(poPhotos).toHaveLength(1);
    expect(poPhotos[0].filename).toBe('a.jpg');
    expect(poPhotos[0].storage_key).not.toBe(src.storage_key);

    // An anonymous part number must not seed the market catalog.
    expect(await sql`SELECT 1 FROM ref_prices WHERE part_number ILIKE 'M393A4K40CB2%'`).toHaveLength(0);

    const again = await api<{ orderId: string }>('POST', `/api/web-submissions/${ref}/convert`, { token });
    expect(again.status).toBe(409);
    expect(again.body.orderId).toBe(conv.body.orderId);
  });

  // match_key is alnum(name)|zip, so a@cme.corp and a hand-typed "Acme Corp"
  // share ACMECORP| — the lot must not land on that house account.
  it('files a lot under its own seller when the email compresses like another supplier', async () => {
    const db = getTestDb();
    const [acme] = await db<{ id: string }[]>`
      INSERT INTO suppliers (name, owner_id) VALUES ('Acme Corp', NULL) RETURNING id
    `;
    const odd = { ...ramLine, fields: { ...ramLine.fields, classification: 'constructor' } };
    const r = await submit({ email: 'a@cme.corp', source: 'web', lines: [odd] }, headers());
    expect(r.status).toBe(201);
    const { token } = await loginAs(ALEX);
    const conv = await api<{ orderId: string }>('POST', `/api/web-submissions/${r.body.ref}/convert`, { token });
    expect(conv.status).toBe(201);

    const [po] = await db<{ supplier_id: string; name: string }[]>`
      SELECT o.supplier_id, s.name FROM orders o JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.id = ${conv.body.orderId}
    `;
    expect(po.supplier_id).not.toBe(acme.id);
    expect(po.name).toBe('a@cme.corp (web)');
    // A free-text class that names an Object.prototype key is not a RAM type.
    const [line] = await db<{ type: string | null }[]>`
      SELECT type FROM order_lines WHERE order_id = ${conv.body.orderId}
    `;
    expect(line.type).toBeNull();
  });

  it('converts a pickup lot as cash at a pickup, and refuses a quote', async () => {
    const lot = await submit({ email: 'local@example.com', source: 'facebook', handoff: 'pickup', pickup_location: 'chicago', lines: [ssdLine] });
    const q = await submitQuote(quote);
    const { token } = await loginAs(ALEX);

    const conv = await api<{ orderId: string }>('POST', `/api/web-submissions/${lot.body.ref}/convert`, { token });
    expect(conv.status).toBe(201);
    const [po] = await getTestDb()`
      SELECT o.payment_method, o.handoff_method, o.source, o.notes, s.source AS supplier_source
      FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ${conv.body.orderId}
    `;
    expect(po).toMatchObject({ payment_method: 'cash', handoff_method: 'pickup', source: 'facebook', supplier_source: 'facebook' });
    expect(po.notes).toContain('chicago');

    expect((await api('POST', `/api/web-submissions/${q.body.ref}/convert`, { token })).status).toBe(400);
  });
});
