#!/usr/bin/env node
// Run SQL files in ./migrations against DATABASE_URL.
// Use --reset to DROP all known tables first (dev only).

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// Read .dev.vars too (Wrangler-style file with KEY=VALUE lines)
function loadDevVars() {
  try {
    const raw = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* fine if missing */ }
}
loadDevVars();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to backend/.dev.vars');
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });
const reset = process.argv.includes('--reset');

try {
  if (reset) {
    console.log('· Dropping existing tables…');
    await sql.unsafe(`
      DROP TABLE IF EXISTS
        sell_order_status_attachments, sell_order_status_meta,
        sell_order_lines, sell_orders, customers,
        inventory_events, workflow_stages,
        catalog_options, payment_terms, price_sources, sell_order_statuses,
        label_scans, notifications, ref_prices,
        categories, commission_tiers, commission_settings, workspace_settings,
        order_lines, orders, warehouses, users CASCADE;
    `);
  }

  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log('→ ' + file);
    const ddl = readFileSync(join(migrationsDir, file), 'utf8');
    await sql.unsafe(ddl);
  }
  console.log('✓ migrations applied');
} catch (e) {
  console.error('✗ migration failed:', e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
