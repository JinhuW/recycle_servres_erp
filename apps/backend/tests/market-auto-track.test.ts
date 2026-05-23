import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// Auto-tracking on PO intake — see lib/marketAutoTrack.ts. Creating a PO line
// with a new part_number should seed a ref_prices row; the second PO with the
// same PN must be a no-op (dedupe), and lines without a part_number are
// skipped silently.

async function countRefPrices(): Promise<number> {
  const sql = getTestDb();
  const r = (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ref_prices`)[0];
  return r.n;
}

async function refPriceFor(pn: string) {
  const sql = getTestDb();
  return (await sql<{
    part_number: string; label: string; category: string;
    target: number | null; avg_sell: number | null; source: string | null;
    samples: number;
  }[]>`
    SELECT part_number, label, category,
           target::float AS target, avg_sell::float AS avg_sell,
           source, samples
    FROM ref_prices
    WHERE LOWER(part_number) = LOWER(${pn})
    LIMIT 1
  `)[0];
}

describe('POST /api/orders — auto-track new parts to ref_prices', () => {
  beforeEach(async () => { await resetDb(); });

  it('inserts a ref_prices row for a never-seen part_number', async () => {
    const before = await countRefPrices();
    const { token } = await loginAs(MARCUS);
    const novelPN = 'TEST-AUTOTRACK-NEW-001';

    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        lines: [{
          category: 'RAM', brand: 'Acme', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: novelPN, condition: 'New',
          qty: 2, unitCost: 42,
        }],
      },
    });
    expect(r.status).toBe(201);

    expect(await countRefPrices()).toBe(before + 1);
    const row = await refPriceFor(novelPN);
    expect(row).toBeTruthy();
    expect(row.part_number).toBe(novelPN);
    expect(row.category).toBe('RAM');
    // Prices are seeded NULL; the scraper fills them later.
    expect(row.target).toBeNull();
    expect(row.avg_sell).toBeNull();
    expect(row.source).toBe('auto-intake');
    // Synthesized label from specs.
    expect(row.label).toContain('Acme');
  });

  it('does not duplicate when the same part_number appears again', async () => {
    const { token } = await loginAs(MARCUS);
    const pn = 'TEST-AUTOTRACK-DUP-001';

    await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', partNumber: pn, condition: 'New', qty: 1, unitCost: 10 }],
      },
    });
    const after1 = await countRefPrices();

    // Whitespace + case variant should still canonicalise to the same row.
    await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', partNumber: '  ' + pn.toLowerCase() + '  ', condition: 'New', qty: 1, unitCost: 10 }],
      },
    });
    expect(await countRefPrices()).toBe(after1);

    // And dedupes within a single batch.
    await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [
          { category: 'RAM', partNumber: 'TEST-AUTOTRACK-BATCH-A', condition: 'New', qty: 1, unitCost: 1 },
          { category: 'RAM', partNumber: 'test-autotrack-batch-a', condition: 'New', qty: 1, unitCost: 1 },
        ],
      },
    });
    // Only +1 from the batch, not +2.
    expect(await countRefPrices()).toBe(after1 + 1);
  });

  it('skips lines without a part_number', async () => {
    const before = await countRefPrices();
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [
          { category: 'RAM', condition: 'New', qty: 1, unitCost: 10 },
          { category: 'RAM', partNumber: '', condition: 'New', qty: 1, unitCost: 10 },
          { category: 'RAM', partNumber: '   ', condition: 'New', qty: 1, unitCost: 10 },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(await countRefPrices()).toBe(before);
  });

  it('PATCH addLines also auto-tracks', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', condition: 'New', qty: 1, unitCost: 10 }],
      },
    });
    const before = await countRefPrices();
    const novelPN = 'TEST-AUTOTRACK-PATCH-001';
    const r = await api('PATCH', `/api/orders/${created.body.id}`, {
      token,
      body: {
        addLines: [{
          category: 'RAM', brand: 'Acme', partNumber: novelPN,
          condition: 'New', qty: 1, unitCost: 10,
        }],
      },
    });
    expect(r.status).toBe(200);
    expect(await countRefPrices()).toBe(before + 1);
    expect((await refPriceFor(novelPN)).part_number).toBe(novelPN);
  });
});
