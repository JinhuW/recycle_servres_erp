import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const market = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Reference prices for the Market Value screen. Search + category filter +
// computed maxBuy (avgSell × (1 - 30% margin target)).
market.get('/', async (c) => {
  const sql = getDb(c.env);
  const category = c.req.query('category');
  const search = c.req.query('q')?.toLowerCase().trim();

  const rows = await sql`
    SELECT id, category, brand, capacity, type, classification, speed,
           interface, form_factor, description, part_number, label, sub_label,
           target::float AS target, low_price::float AS low_price,
           high_price::float AS high_price, avg_sell::float AS avg_sell,
           trend, samples, source, stock, demand, history, updated_at
    FROM ref_prices
    WHERE (${category ?? null}::text IS NULL OR category = ${category ?? null})
      AND (
        ${search ?? null}::text IS NULL
        OR LOWER(label) LIKE '%' || ${search ?? ''} || '%'
        OR LOWER(COALESCE(part_number,'')) LIKE '%' || ${search ?? ''} || '%'
      )
    ORDER BY updated_at DESC
    LIMIT 100
  `;

  const TARGET_MARGIN = 0.30;
  return c.json({
    items: rows.map(r => ({
      id: r.id,
      category: r.category,
      brand: r.brand,
      capacity: r.capacity,
      type: r.type,
      classification: r.classification,
      speed: r.speed,
      interface: r.interface,
      formFactor: r.form_factor,
      description: r.description,
      partNumber: r.part_number,
      label: r.label,
      sub: r.sub_label,
      target: r.target,
      low: r.low_price,
      high: r.high_price,
      avgSell: r.avg_sell,
      trend: r.trend,
      samples: r.samples,
      source: r.source,
      stock: r.stock,
      demand: r.demand,
      history: r.history,
      updated: r.updated_at,
      maxBuy: +(r.avg_sell * (1 - TARGET_MARGIN)).toFixed(2),
    })),
  });
});

export default market;
