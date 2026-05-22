import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { formatRefPrice } from '../src/lib/market';

describe('formatRefPrice', () => {
  beforeAll(async () => { await resetDb(); });

  it('maps a ref_prices row to the MarketValue DTO', async () => {
    const db = getTestDb();
    const row = (await db<any[]>`
      SELECT id, category, brand, capacity, type, classification, rank, speed,
             interface, form_factor, description, part_number, label, sub_label,
             target::float AS target, low_price::float AS low_price,
             high_price::float AS high_price, avg_sell::float AS avg_sell,
             trend, samples, source, stock, demand, history, updated_at,
             health::float AS health, rpm
      FROM ref_prices LIMIT 1
    `)[0];
    const v = formatRefPrice(row, 0.30);
    // Pass-through snake→camel renames must all be wired correctly so the MCP
    // tool and REST endpoint share a single contract.
    expect(v).toMatchObject({
      id: row.id,
      category: row.category,
      brand: row.brand,
      capacity: row.capacity,
      type: row.type,
      classification: row.classification,
      rank: row.rank,
      speed: row.speed,
      interface: row.interface,
      formFactor: row.form_factor,
      description: row.description,
      partNumber: row.part_number,
      label: row.label,
      sub: row.sub_label,
      target: row.target,
      low: row.low_price,
      high: row.high_price,
      avgSell: row.avg_sell,
      trend: row.trend,
      samples: row.samples,
      source: row.source,
      stock: row.stock,
      demand: row.demand,
      health: row.health,
      rpm: row.rpm,
    });
    expect(v.maxBuy).toBe(+(row.avg_sell * 0.70).toFixed(2));
    expect(v.updatedAt).toBe(row.updated_at.toISOString());
  });
});
