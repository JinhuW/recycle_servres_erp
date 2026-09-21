import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';

// The per-IP limiter is module state shared by every test in this file, so
// each test speaks from its own address; the 429 test is the only one that
// repeats one.
let ipSeq = 0;
const ip = () => `203.0.113.${++ipSeq}`;
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

// Public endpoint: no cookie, and deliberately no X-Requested-By — the CSRF
// guard exempts /api/public/*, and a browser on another origin can't send it.
function submit(body: unknown, h: Record<string, string> = {}) {
  return api<{ ref: string | null; lines?: number; units?: number; error?: string }>(
    'POST', '/api/public/intake', { body, headers: headers({ 'X-Requested-By': '', ...h }) });
}

describe('POST /api/public/intake', () => {
  beforeEach(async () => { await resetDb(); });

  it('files a JSON lot as a Draft PO on a house-account supplier and tells managers', async () => {
    const r = await submit({ email: 'Seller@Example.com', notes: 'Pulled from an R740', source: 'web', lines: [ramLine, ssdLine] });
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(/^PO-\d+$/);
    expect(r.body.lines).toBe(2);
    expect(r.body.units).toBe(30);

    const sql = getTestDb();
    const [po] = await sql`
      SELECT o.lifecycle, o.payment, o.payment_method, o.commission_rate::float AS commission_rate,
             o.source, o.notes, o.category, o.total_cost::float AS total_cost,
             u.role AS owner_role, s.email AS supplier_email, s.source AS supplier_source,
             s.status AS supplier_status, s.owner_id AS supplier_owner
      FROM orders o
      JOIN users u ON u.id = o.user_id
      JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.id = ${r.body.ref!}
    `;
    expect(po.lifecycle).toBe('draft');
    expect(po.payment).toBe('company');
    expect(po.payment_method).toBe('paypal');
    expect(po.commission_rate).toBe(0);
    expect(po.source).toBe('other');
    expect(po.notes).toContain('PayPal seller@example.com');
    expect(po.notes).toContain('Pulled from an R740');
    expect(po.category).toBe('Mixed');
    expect(po.total_cost).toBe(0);
    expect(po.owner_role).toBe('manager');
    expect(po.supplier_email).toBe('seller@example.com');
    expect(po.supplier_source).toBe('web');
    expect(po.supplier_status).toBe('prospect');
    expect(po.supplier_owner).toBeNull();

    const lines = await sql`
      SELECT category, classification, type, capacity, speed, rank, brand, interface, form_factor,
             part_number, condition, qty, unit_cost::float AS unit_cost, status, position
      FROM order_lines WHERE order_id = ${r.body.ref!} ORDER BY position
    `;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      category: 'RAM', classification: 'RDIMM', type: 'Server', capacity: '32GB', speed: '2933',
      rank: '2Rx4', brand: 'Samsung', part_number: 'M393A4K40CB2-CVF',
      condition: 'Pulled — Untested', qty: 24, unit_cost: 0, status: 'Draft', position: 0,
    });
    expect(lines[1]).toMatchObject({
      category: 'SSD', interface: 'SATA', form_factor: '2.5"', part_number: 'MZ7LH960HAJR', qty: 6, position: 1,
    });

    const events = await sql`SELECT kind FROM order_events WHERE order_id = ${r.body.ref!} ORDER BY created_at`;
    expect(events.map(e => e.kind)).toEqual(['created', 'line_added', 'line_added']);

    const notes = await sql`
      SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.kind = 'intake' AND u.role = 'manager'
    `;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].title).toBe(`New sell request ${r.body.ref}`);

    // An anonymous part number must not seed the market catalog.
    const tracked = await sql`SELECT 1 FROM ref_prices WHERE part_number ILIKE 'M393A4K40CB2%'`;
    expect(tracked).toHaveLength(0);
  });

  it('files a CPU as an Other line by item type, and keeps the ?src= channel', async () => {
    const r = await submit({ email: 'cpu@example.com', source: 'reddit', lines: [cpuLine] });
    expect(r.status).toBe(201);
    const sql = getTestDb();
    const [line] = await sql`
      SELECT category, item_type, description, part_number, brand FROM order_lines WHERE order_id = ${r.body.ref!}
    `;
    expect(line).toMatchObject({ category: 'Other', item_type: 'CPU', description: 'Xeon Gold 6248R', part_number: 'SRGZG', brand: 'Intel' });
    const [po] = await sql`SELECT o.source, s.source AS supplier_source FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ${r.body.ref!}`;
    expect(po.source).toBe('reddit');
    expect(po.supplier_source).toBe('reddit');
  });

  it('attaches multipart photos to their lines', async () => {
    const payload = JSON.stringify({ email: 'photos@example.com', source: 'web', lines: [{ category: 'RAM', qty: 1, fields: {} }, ssdLine] });
    const r = await multipart('/api/public/intake', {
      payload, 'photo-0-0': jpeg('a.jpg'), 'photo-0-1': jpeg('b.jpg'), 'photo-1-0': jpeg('c.jpg'),
    }, { headers: headers({ 'X-Requested-By': '' }) });
    expect(r.status).toBe(201);
    const ref = (r.body as { ref: string }).ref;
    const sql = getTestDb();
    const photos = await sql`
      SELECT l.position AS line, p.filename, p.position, p.mime_type
      FROM order_line_photos p JOIN order_lines l ON l.id = p.order_line_id
      WHERE p.order_id = ${ref} ORDER BY l.position, p.position
    `;
    expect(photos.map(p => [p.line, p.filename, p.position, p.mime_type])).toEqual([
      [0, 'a.jpg', 0, 'image/jpeg'], [0, 'b.jpg', 1, 'image/jpeg'], [1, 'c.jpg', 0, 'image/jpeg'],
    ]);
  });

  it('refuses a non-image photo with 415', async () => {
    const payload = JSON.stringify({ email: 'bad@example.com', source: 'web', lines: [ramLine] });
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'x.pdf', { type: 'application/pdf' });
    const r = await multipart('/api/public/intake', { payload, 'photo-0-0': pdf },
      { headers: headers({ 'X-Requested-By': '' }) });
    expect(r.status).toBe(415);
  });

  it('400s on bad input', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ email: 'nope', source: 'web', lines: [ramLine] }, /email/],
      [{ email: 'a@b.co', source: 'web', lines: [] }, /at least one line/],
      [{ email: 'a@b.co', source: 'web', lines: [{ category: 'GPU', qty: 1, fields: {} }] }, /category/],
      [{ email: 'a@b.co', source: 'web', lines: [{ category: 'RAM', qty: 0, fields: {} }] }, /qty/],
      [{ email: 'a@b.co', source: 'web', lines: [{ category: 'RAM', qty: 1, fields: { brand: 'Samsung' } }] }, /photo or at least/],
    ];
    for (const [body, msg] of cases) {
      const r = await submit(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const sql = getTestDb();
    const pos = await sql`SELECT 1 FROM orders WHERE notes LIKE 'Web intake%'`;
    expect(pos).toHaveLength(0);
  });

  it('swallows a filled honeypot without writing', async () => {
    const r = await submit({ email: 'bot@example.com', website: 'http://spam', source: 'web', lines: [ramLine] });
    expect(r.status).toBe(200);
    expect(r.body.ref).toBeNull();
    const sql = getTestDb();
    expect(await sql`SELECT 1 FROM suppliers WHERE email = 'bot@example.com'`).toHaveLength(0);
  });

  it('reuses the supplier across submissions from one email, however it is spelled', async () => {
    const a = await submit({ email: 'john.doe@example.com', source: 'web', lines: [ramLine] });
    const b = await submit({ email: 'johndoe@example.com', source: 'web', lines: [ssdLine] });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const sql = getTestDb();
    const rows = await sql`
      SELECT o.id, o.supplier_id FROM orders o WHERE o.id IN (${a.body.ref!}, ${b.body.ref!})
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].supplier_id).toBe(rows[1].supplier_id);
    // One CRM row; the alnum match key folds the dot away.
    expect(await sql`SELECT 1 FROM suppliers WHERE email LIKE '%doe@example.com'`).toHaveLength(1);
  });

  it('429s the sixth submission from one address inside a minute, with Retry-After', async () => {
    const addr = ip();
    for (let i = 0; i < 5; i++) {
      const r = await submit({ email: `s${i}@example.com`, source: 'web', lines: [ramLine] }, { 'X-Forwarded-For': addr });
      expect(r.status).toBe(201);
    }
    const r = await submit({ email: 's6@example.com', source: 'web', lines: [ramLine] }, { 'X-Forwarded-For': addr });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
