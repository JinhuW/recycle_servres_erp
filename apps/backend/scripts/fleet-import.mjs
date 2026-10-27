#!/usr/bin/env node
// Load the fleet's catalog from the trackers' master.toml: every region's
// cities, the items with their phrases and filters, and the search settings.
//
//   node scripts/fleet-import.mjs --master ../../trackers/facebook/configs/master.toml [--dry-run] [--overwrite]
//
// Cities arrive enabled and verified as 'imported': every slug in master.toml
// was resolved against Facebook's own location picker when it was added, so the
// worker's verify step would only repeat that.
//
// By default only what the ERP lacks is written: new cities, new items, search
// keys never saved. A city or item that differs from master.toml is listed and
// kept as it is, because a manager's edit (a removed city, a name, a phrase
// list) is the newer word once the ERP runs the fleet. `--overwrite` makes
// master.toml win for those too, re-enabling cities a manager removed; a
// slug already verified keeps its verification.
//
// Writes go to DATABASE_URL, and only a local one unless
// FLEET_IMPORT_REMOTE=true: a shell left holding a `railway variables`
// DATABASE_URL is one command away from undoing managers' edits on prod.

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import './load-env.mjs';
import { dbTarget, destructiveRefusal } from '../src/lib/dbTarget.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const overwrite = args.includes('--overwrite');
const masterAt = args.indexOf('--master');
const masterPath = masterAt >= 0 ? args[masterAt + 1] : null;
if (!masterPath) {
  console.error('usage: fleet-import.mjs --master <path to master.toml> [--dry-run]');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to the repo-root .env');
  process.exit(1);
}
if (!dryRun) {
  const refused = destructiveRefusal(url, 'fleet import', 'FLEET_IMPORT_REMOTE', process.env);
  if (refused) {
    console.error(refused);
    process.exit(1);
  }
}

// The search settings the fleet hands to workers; the same set the console
// let managers change, minus start_at, which the fleet has no use for.
const SEARCH_KEYS = [
  'date_listed', 'delivery_method', 'max_results', 'search_interval', 'max_search_interval',
  'title_prefilter', 'min_seller_rating', 'exclude_unrated_sellers', 'rating', 'min_unit_count',
  'prompt', 'rating_prompt',
];
// Per-item filters: what the monitor reads from an [item.*] table besides the
// phrases. Search keys set on an item override the fleet-wide ones.
const ITEM_KEYS = ['keywords', 'antikeywords', 'description', ...SEARCH_KEYS];

export function readMaster(text) {
  const doc = parse(text);
  const cities = [];
  for (const [key, region] of Object.entries(doc.region ?? {})) {
    const slugs = region.search_city ?? [];
    const names = region.city_name ?? [];
    const radii = region.radius ?? [];
    if (names.length !== slugs.length || radii.length !== slugs.length) {
      throw new Error(`region.${key}: search_city, city_name and radius must have the same length`);
    }
    slugs.forEach((slug, i) => {
      cities.push({ slug: String(slug), name: names[i], radius_km: radii[i], region: region.full_name ?? key });
    });
  }
  const items = Object.entries(doc.item ?? {}).map(([name, item]) => {
    const filters = {};
    for (const k of ITEM_KEYS) if (item[k] !== undefined) filters[k] = item[k];
    return { name, phrases: item.search_phrases ?? [], filters };
  });
  const fb = doc.marketplace?.facebook ?? {};
  const search = {};
  for (const k of SEARCH_KEYS) if (fb[k] !== undefined) search[k] = fb[k];
  return { cities, items, search };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const master = readMaster(readFileSync(masterPath, 'utf8'));
  const dup = master.cities.map((c) => c.slug).filter((s, i, all) => all.indexOf(s) !== i);
  if (dup.length) throw new Error(`master.toml lists a city twice: ${[...new Set(dup)].join(', ')}`);

  console.log(`${dryRun ? 'dry run against' : 'importing into'} ${dbTarget(url).host}/${dbTarget(url).database}`);
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  try {
    const have = {
      cities: new Map((await sql`SELECT slug, name, radius_km, region, enabled FROM fleet_cities`).map((r) => [r.slug, r])),
      items: new Map((await sql`SELECT name, phrases, filters FROM fleet_items`).map((r) => [r.name, r])),
      search: (await sql`SELECT value FROM fleet_settings WHERE key = 'search'`)[0]?.value ?? null,
    };

    const diff = { cities: { added: [], changed: [], unchanged: 0 }, items: { added: [], changed: [], unchanged: 0 }, search: 'unchanged' };
    for (const c of master.cities) {
      const h = have.cities.get(c.slug);
      if (!h) diff.cities.added.push(c.slug);
      else if (h.name !== c.name || h.radius_km !== c.radius_km || h.region !== c.region || !h.enabled) diff.cities.changed.push(c.slug);
      else diff.cities.unchanged += 1;
    }
    for (const i of master.items) {
      const h = have.items.get(i.name);
      if (!h) diff.items.added.push(i.name);
      else if (!same(h.phrases, i.phrases) || !same(h.filters, i.filters)) diff.items.changed.push(i.name);
      else diff.items.unchanged += 1;
    }
    // Saved search values win, so only keys never saved are a change.
    const newKeys = Object.keys(master.search).filter((k) => !have.search || !(k in have.search));
    if (!have.search) diff.search = 'added';
    else if (newKeys.length) diff.search = `${newKeys.length} new key(s): ${newKeys.join(', ')}`;

    const kept = overwrite ? 'changed' : 'differ (kept; --overwrite takes master.toml\'s)';
    console.log(`cities: ${diff.cities.added.length} new, ${diff.cities.changed.length} changed, ${diff.cities.unchanged} unchanged (${master.cities.length} in master.toml)`);
    if (diff.cities.added.length) console.log(`  new: ${diff.cities.added.join(', ')}`);
    if (diff.cities.changed.length) console.log(`  ${kept}: ${diff.cities.changed.join(', ')}`);
    console.log(`items: ${diff.items.added.length} new, ${diff.items.changed.length} changed, ${diff.items.unchanged} unchanged (${master.items.map((i) => i.name).join(', ')})`);
    if (diff.items.changed.length) console.log(`  ${kept}: ${diff.items.changed.join(', ')}`);
    console.log(`search settings: ${diff.search} (${Object.keys(master.search).join(', ')})`);
    if (dryRun) return;

    await sql.begin(async (tx) => {
      for (const c of master.cities) {
        if (!overwrite) {
          await tx`
            INSERT INTO fleet_cities (slug, name, radius_km, region, enabled, verified_at, verified_as)
            VALUES (${c.slug}, ${c.name}, ${c.radius_km}, ${c.region}, TRUE, NOW(), 'imported')
            ON CONFLICT (slug) DO NOTHING`;
          continue;
        }
        await tx`
          INSERT INTO fleet_cities (slug, name, radius_km, region, enabled, verified_at, verified_as)
          VALUES (${c.slug}, ${c.name}, ${c.radius_km}, ${c.region}, TRUE, NOW(), 'imported')
          ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name, radius_km = EXCLUDED.radius_km, region = EXCLUDED.region,
            enabled = TRUE, disabled_at = NULL,
            verified_at = COALESCE(fleet_cities.verified_at, NOW()),
            verified_as = CASE WHEN fleet_cities.verified_at IS NULL THEN 'imported' ELSE fleet_cities.verified_as END`;
      }
      for (const i of master.items) {
        await tx`
          INSERT INTO fleet_items (name, phrases, filters, enabled)
          VALUES (${i.name}, ${tx.json(i.phrases)}, ${tx.json(i.filters)}, TRUE)
          ON CONFLICT (name) DO ${overwrite ? tx`UPDATE SET phrases = EXCLUDED.phrases, filters = EXCLUDED.filters` : tx`NOTHING`}`;
      }
      // Saved search values win over master.toml's, as they did on the console.
      const merged = { ...master.search, ...(have.search ?? {}) };
      await tx`
        INSERT INTO fleet_settings (key, value, updated_at) VALUES ('search', ${tx.json(merged)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    });
    console.log('imported; the scheduler writes the tasks on its next tick');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
