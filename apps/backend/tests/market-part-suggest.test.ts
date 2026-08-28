import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Typeahead over the part numbers already on record. POST /lookup answers only
// an exact canonical match, which is no help mid-keystroke — this is what stops
// a purchaser coining a second spelling of a part the book already carries.
//
// Every fixture uses a ZZ prefix so the seeded catalogue can't drift the
// assertions.

type SuggestBody = { items: { partNumber: string; label: string | null; category: string | null }[] };

async function seedRef(id: string, partNumber: string, label = 'seed ' + id) {
  const db = getTestDb();
  await db`
    INSERT INTO ref_prices (id, category, label, part_number, updated_at)
    VALUES (${id}, 'RAM', ${label}, ${partNumber}, NOW())
  `;
}

async function seedLine(partNumber: string, opts: { brand?: string; capacity?: string } = {}) {
  const db = getTestDb();
  const [{ id: userId }] = await db<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  const orderId = 'ZZ-ORD-' + partNumber.replace(/[^A-Za-z0-9]/g, '');
  await db`
    INSERT INTO orders (id, user_id, category, lifecycle, created_at)
    VALUES (${orderId}, ${userId}, 'RAM', 'draft', NOW())
  `;
  await db`
    INSERT INTO order_lines (order_id, category, qty, unit_cost, part_number, brand, capacity, position)
    VALUES (${orderId}, 'RAM', 1, 10, ${partNumber}, ${opts.brand ?? null}, ${opts.capacity ?? null}, 0)
  `;
}

const suggest = (q: string, token: string) =>
  api<SuggestBody>('GET', `/api/market/parts?q=${encodeURIComponent(q)}`, { token });

describe('GET /api/market/parts', () => {
  beforeEach(async () => { await resetDb(); });

  it('matches on the canonical form, not the stored spelling', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-1', 'PN: ZZAB 123');

    const r = await suggest('zzab1', token);
    expect(r.status).toBe(200);
    expect(r.body.items.map(i => i.partNumber)).toEqual(['PN: ZZAB 123']);
  });

  it('matches a fragment from the middle of a part number', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-2', 'M393ZZMID44-CWE');

    const r = await suggest('zzmid', token);
    expect(r.body.items.map(i => i.partNumber)).toEqual(['M393ZZMID44-CWE']);
  });

  it('carries the label and category for the row', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-3', 'ZZLABEL-1', 'Samsung 32GB DDR4');

    const [item] = (await suggest('zzlabel', token)).body.items;
    expect(item).toMatchObject({ label: 'Samsung 32GB DDR4', category: 'RAM' });
  });

  it('finds a part that only an order line has ever carried', async () => {
    const { token } = await loginAs(ALEX);
    await seedLine('ZZLINEONLY-9', { brand: 'Hynix', capacity: '64GB' });

    const [item] = (await suggest('zzlineonly', token)).body.items;
    expect(item).toMatchObject({ partNumber: 'ZZLINEONLY-9', label: 'Hynix 64GB' });
  });

  it('returns one row per part when both catalogues carry it', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-4', 'ZZBOTH-7', 'from ref_prices');
    await seedLine('ZZBOTH-7', { brand: 'Micron' });

    const items = (await suggest('zzboth', token)).body.items;
    expect(items).toHaveLength(1);
    // ref_prices wins the tie: it is the side with a curated label.
    expect(items[0].label).toBe('from ref_prices');
  });

  it('collapses two ref_prices rows that canonicalise alike', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-5a', 'ZZDUP 100');
    await seedRef('rp-zz-5b', 'PN:ZZDUP100');

    expect((await suggest('zzdup', token)).body.items).toHaveLength(1);
  });

  it('ranks prefix matches above interior ones, shortest first', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-6a', 'XX-ZZRANK-INSIDE');
    await seedRef('rp-zz-6b', 'ZZRANK-LONGER-ONE');
    await seedRef('rp-zz-6c', 'ZZRANK-1');

    const items = (await suggest('zzrank', token)).body.items.map(i => i.partNumber);
    expect(items).toEqual(['ZZRANK-1', 'ZZRANK-LONGER-ONE', 'XX-ZZRANK-INSIDE']);
  });

  it('caps the menu at 12 rows', async () => {
    const { token } = await loginAs(ALEX);
    for (let i = 0; i < 15; i++) await seedRef('rp-zz-cap-' + i, `ZZCAP-${100 + i}`);

    expect((await suggest('zzcap', token)).body.items).toHaveLength(12);
  });

  it('says nothing until there are two characters to go on', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-7', 'ZZSHORT-1');

    expect((await suggest('z', token)).body.items).toEqual([]);
    expect((await suggest('', token)).body.items).toEqual([]);
    expect((await suggest('  ', token)).body.items).toEqual([]);
  });

  it('treats a LIKE wildcard as a literal, not a match-everything', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-8', 'ZZWILD-1');

    expect((await suggest('%%', token)).body.items).toEqual([]);
    expect((await suggest('z%', token)).body.items).toEqual([]);
    expect((await suggest('__', token)).body.items).toEqual([]);
  });

  it('counts characters before escaping them, not after', async () => {
    const { token } = await loginAs(ALEX);
    await seedRef('rp-zz-9', 'ZZGATE-1');

    // escapeLike doubles a lone metacharacter, so escaping first would let a
    // single typed character through a gate that exists to require two — and
    // the client's own gate measures the unescaped form.
    for (const q of ['_', '%', '\\']) {
      expect((await suggest(q, token)).body.items).toEqual([]);
    }
  });

  it('requires a session', async () => {
    const r = await api('GET', '/api/market/parts?q=zzab1');
    expect(r.status).toBe(401);
  });
});
