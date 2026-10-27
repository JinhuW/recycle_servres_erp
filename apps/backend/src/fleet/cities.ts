import type { JSONValue, Sql } from 'postgres';
import {
  FLEET_SETTINGS_DEFAULTS,
  type FleetCity,
  type FleetCityListed,
  type FleetItem,
  type FleetSearchSettings,
  type FleetSettings,
} from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { bad, exists, iso, notFound, taskToWire, type Refusal, type TaskRow } from './sql';
import { notifyReady } from './scheduler';

// ─── The catalog: cities, items, settings ─────────────────────────────────────
// What the scheduler reads to decide what the fleet searches. Managers edit it
// here; the worker never writes to it. A city starts disabled: its slug has to
// be verified by a worker first, because a slug Facebook does not know makes
// it search the account's own city and return plausible listings from the
// wrong part of the country, silently. `override_verify` is the manager's way
// past that for a slug they have checked by hand.

export type CityRow = {
  slug: string;
  name: string;
  radius_km: number;
  region: string | null;
  enabled: boolean;
  per_day: number | null;
  pinned: boolean;
  verified_at: Date | null;
  verified_as: string | null;
  added_by: string | null;
  added_at: Date;
  disabled_at: Date | null;
};

type ItemRow = {
  name: string;
  phrases: string[];
  filters: Record<string, unknown>;
  enabled: boolean;
};

/** The monitor's rule for a Marketplace location: a slug or a numeric id. */
export const CITY_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ITEM_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_CITY_NAME = 80;
const MAX_RADIUS_KM = 500;
const MAX_PER_DAY = 24;
const MAX_PHRASES = 100;
const MAX_PHRASE = 500;
export const VERIFY_PRIORITY = 50;

const cityToWire = (r: CityRow): FleetCity => ({
  slug: r.slug,
  name: r.name,
  radius_km: r.radius_km,
  region: r.region,
  enabled: r.enabled,
  per_day: r.per_day,
  pinned: r.pinned,
  verified_at: iso(r.verified_at),
  verified_as: r.verified_as,
  added_by: r.added_by,
  added_at: r.added_at.toISOString(),
  disabled_at: iso(r.disabled_at),
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

// ── Cities ───────────────────────────────────────────────────────────────────

export type CityDraft = { slug: string; name: string; radius_km: number; region: string | null };

export function readCityDraft(input: unknown): CityDraft | Refusal {
  if (!isObject(input)) return bad('expected an object');
  const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
  if (!CITY_SLUG.test(slug)) {
    return bad('slug must be the part after /marketplace/ in a search URL: lowercase letters, digits, _ and -');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_CITY_NAME) return bad(`name must be 1 to ${MAX_CITY_NAME} characters`);
  const radius = input.radius_km ?? MAX_RADIUS_KM;
  if (!isInt(radius, 1, MAX_RADIUS_KM)) return bad(`radius_km must be a whole number from 1 to ${MAX_RADIUS_KM}`);
  let region: string | null = null;
  if (input.region !== undefined && input.region !== null) {
    if (typeof input.region !== 'string' || input.region.trim().length > MAX_CITY_NAME) {
      return bad(`region must be text of at most ${MAX_CITY_NAME} characters`);
    }
    region = input.region.trim() || null;
  }
  return { slug, name, radius_km: radius, region };
}

export type CityPatch = {
  enabled?: boolean;
  per_day?: number | null;
  pinned?: boolean;
  name?: string;
  override_verify?: true;
  reverify?: true;
};

export function readCityPatch(input: unknown): CityPatch | Refusal {
  if (!isObject(input)) return bad('expected an object');
  const unknown = Object.keys(input).filter((k) => !['enabled', 'per_day', 'pinned', 'name', 'override_verify', 'reverify'].includes(k));
  if (unknown.length) return bad(`not a city field: ${unknown.join(', ')}`);
  const patch: CityPatch = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return bad('enabled must be true or false');
    patch.enabled = input.enabled;
  }
  if (input.per_day !== undefined) {
    if (input.per_day !== null && !isInt(input.per_day, 1, MAX_PER_DAY)) {
      return bad(`per_day must be null or a whole number from 1 to ${MAX_PER_DAY}`);
    }
    patch.per_day = input.per_day;
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') return bad('pinned must be true or false');
    patch.pinned = input.pinned;
  }
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MAX_CITY_NAME) return bad(`name must be 1 to ${MAX_CITY_NAME} characters`);
    patch.name = name;
  }
  if (input.override_verify !== undefined) {
    if (input.override_verify !== true) return bad('override_verify can only be true');
    patch.override_verify = true;
  }
  if (input.reverify !== undefined) {
    if (input.reverify !== true) return bad('reverify can only be true');
    if (patch.override_verify || patch.enabled === true) return bad('reverify cannot be combined with enabled or override_verify');
    patch.reverify = true;
  }
  if (Object.keys(patch).length === 0) return bad('nothing to change');
  return patch;
}

/** Every city with its open tasks and the last finished search per item. */
export async function listCities(sql: SqlLike): Promise<FleetCityListed[]> {
  const [rows, open, done] = await Promise.all([
    sql<CityRow[]>`SELECT * FROM fleet_cities ORDER BY region NULLS LAST, name, slug`,
    sql<TaskRow[]>`SELECT * FROM fleet_tasks WHERE state IN ('ready', 'leased') ORDER BY city, item, kind`,
    sql<{ city: string; item: string; last: Date }[]>`
      SELECT city, item, MAX(done_at) AS last FROM fleet_tasks
      WHERE state = 'done' AND kind = 'search' GROUP BY city, item`,
  ]);
  return rows.map((r) => assemble(r, open, done));
}

export async function loadCity(sql: SqlLike, slug: string): Promise<FleetCityListed | null> {
  const [row] = await sql<CityRow[]>`SELECT * FROM fleet_cities WHERE slug = ${slug}`;
  if (!row) return null;
  const [open, done] = await Promise.all([
    sql<TaskRow[]>`SELECT * FROM fleet_tasks WHERE city = ${slug} AND state IN ('ready', 'leased') ORDER BY item, kind`,
    sql<{ city: string; item: string; last: Date }[]>`
      SELECT city, item, MAX(done_at) AS last FROM fleet_tasks
      WHERE city = ${slug} AND state = 'done' AND kind = 'search' GROUP BY city, item`,
  ]);
  return assemble(row, open, done);
}

function assemble(r: CityRow, open: TaskRow[], done: { city: string; item: string; last: Date }[]): FleetCityListed {
  const last_done_at: Record<string, string> = {};
  for (const d of done) if (d.city === r.slug) last_done_at[d.item] = d.last.toISOString();
  return {
    ...cityToWire(r),
    open_tasks: open.filter((t) => t.city === r.slug).map(taskToWire),
    last_done_at,
  };
}

/**
 * A new city: disabled, with a verify-slug task on the first enabled item so
 * a worker checks what Facebook calls the slug before anything searches it.
 * Without an item there is nothing to search for, so no task is written and
 * the city waits for the first item.
 */
export async function createCity(sql: Sql, draft: CityDraft, userId: string): Promise<FleetCityListed | Refusal> {
  try {
    return await sql.begin(async (tx) => {
      await tx`
        INSERT INTO fleet_cities (slug, name, radius_km, region, enabled, added_by)
        VALUES (${draft.slug}, ${draft.name}, ${draft.radius_km}, ${draft.region}, FALSE, ${userId})`;
      const [item] = await tx<{ name: string }[]>`SELECT name FROM fleet_items WHERE enabled ORDER BY name LIMIT 1`;
      if (item) {
        await tx`
          INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
          VALUES (${draft.slug}, ${item.name}, 'verify-slug', NOW(), ${VERIFY_PRIORITY}, 'ready', 'verify')`;
        // Delivered at commit. Without it a worker holding an empty poll sees
        // the check only when its hold runs out, up to poll_hold_seconds later.
        await notifyReady(tx, [item.name]);
      }
      return (await loadCity(tx, draft.slug))!;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return exists(`city ${draft.slug} already exists`);
    throw e;
  }
}

/**
 * Whether the city's slug was confirmed: by a manager (`override`), by the
 * import, or by the latest worker verdict (a `finished` event with a boolean
 * `matches` and no error or wall, the rule claim.ts applies). A verdict
 * of "Facebook calls this somewhere else" sets `verified_at` too, so that
 * alone is not a reason to let the city be enabled.
 */
export async function slugConfirmed(sql: SqlLike, row: CityRow): Promise<boolean> {
  if (!row.verified_at) return false;
  if (row.verified_as === 'override' || row.verified_as === 'imported') return true;
  const [v] = await sql<{ matches: boolean }[]>`
    SELECT e.detail->'matches' = 'true'::jsonb AS matches
    FROM fleet_task_events e JOIN fleet_tasks t ON t.id = e.task_id
    WHERE t.city = ${row.slug} AND t.kind = 'verify-slug' AND e.kind = 'finished'
      AND jsonb_typeof(e.detail->'matches') = 'boolean'
      AND COALESCE(e.detail->'error', 'null'::jsonb) = 'null'::jsonb
      AND COALESCE(e.detail->'wall', 'null'::jsonb) = 'null'::jsonb
    ORDER BY e.at DESC, e.id DESC LIMIT 1`;
  return v?.matches === true;
}

export async function updateCity(sql: Sql, slug: string, patch: CityPatch): Promise<FleetCityListed | Refusal> {
  return sql.begin(async (tx) => {
    const [row] = await tx<CityRow[]>`SELECT * FROM fleet_cities WHERE slug = ${slug} FOR UPDATE`;
    if (!row) return notFound(`no city ${slug}`);
    const next = { ...row };
    // A fresh check: the slug's verdict is forgotten and the city waits,
    // disabled, for the scheduler's next verify-slug task. This is also the
    // way back for a removed city that was never verified.
    if (patch.reverify) {
      next.verified_at = null;
      next.verified_as = null;
      next.enabled = false;
      next.disabled_at = null;
    }
    if (patch.override_verify) {
      next.verified_at = new Date();
      next.verified_as = 'override';
      next.enabled = true;
      next.disabled_at = null;
    }
    if (patch.enabled === true && !patch.override_verify) {
      if (!next.verified_at) return { status: 409, body: { error: 'unverified', detail: `${slug} has not been verified; pass override_verify to enable it anyway` } };
      if (!(await slugConfirmed(tx, next))) {
        return { status: 409, body: { error: 'unverified', detail: `the last check did not confirm ${slug} is ${next.name}${next.verified_as ? ` (Facebook showed ${next.verified_as})` : ''}; pass override_verify to enable it anyway, or reverify to check again` } };
      }
      next.enabled = true;
      next.disabled_at = null;
    } else if (patch.enabled === false) {
      next.enabled = false;
      next.disabled_at = next.disabled_at ?? new Date();
    }
    if (patch.per_day !== undefined) next.per_day = patch.per_day;
    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    if (patch.name !== undefined) next.name = patch.name;
    await tx`
      UPDATE fleet_cities SET
        name = ${next.name}, enabled = ${next.enabled}, per_day = ${next.per_day}, pinned = ${next.pinned},
        verified_at = ${next.verified_at}, verified_as = ${next.verified_as}, disabled_at = ${next.disabled_at}
      WHERE slug = ${slug}`;
    // A manager who vouches for the slug has no use for the worker's check.
    if (patch.override_verify) {
      await tx`
        UPDATE fleet_tasks SET state = 'cancelled', done_at = NOW()
        WHERE city = ${slug} AND kind = 'verify-slug' AND state = 'ready'`;
    }
    return (await loadCity(tx, slug))!;
  });
}

/** Disables the city and cancels what was waiting; a search under way finishes on its own. */
export async function removeCity(sql: Sql, slug: string): Promise<FleetCityListed | Refusal> {
  return sql.begin(async (tx) => {
    const [row] = await tx<CityRow[]>`SELECT slug FROM fleet_cities WHERE slug = ${slug} FOR UPDATE`;
    if (!row) return notFound(`no city ${slug}`);
    await tx`UPDATE fleet_cities SET enabled = FALSE, disabled_at = COALESCE(disabled_at, NOW()) WHERE slug = ${slug}`;
    await tx`UPDATE fleet_tasks SET state = 'cancelled', done_at = NOW() WHERE city = ${slug} AND state = 'ready'`;
    return (await loadCity(tx, slug))!;
  });
}

// ── Items ────────────────────────────────────────────────────────────────────

export function readItems(input: unknown): FleetItem[] | Refusal {
  if (!Array.isArray(input) || input.length === 0) return bad('expected a non-empty list of items');
  const out: FleetItem[] = [];
  for (const raw of input) {
    if (!isObject(raw)) return bad('each item is {name, phrases, filters?, enabled?}');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!ITEM_NAME.test(name)) return bad('name must be lowercase letters, digits and _, like server_ram');
    if (out.some((i) => i.name === name)) return bad(`${name} is listed twice`);
    if (!Array.isArray(raw.phrases) || raw.phrases.length === 0 || raw.phrases.length > MAX_PHRASES) {
      return bad(`${name}: phrases must list 1 to ${MAX_PHRASES} search phrases`);
    }
    const phrases: string[] = [];
    for (const p of raw.phrases) {
      if (typeof p !== 'string' || !p.trim() || p.length > MAX_PHRASE) {
        return bad(`${name}: each phrase is text of 1 to ${MAX_PHRASE} characters`);
      }
      if (!phrases.includes(p.trim())) phrases.push(p.trim());
    }
    if (raw.filters !== undefined && !isObject(raw.filters)) return bad(`${name}: filters must be an object`);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return bad(`${name}: enabled must be true or false`);
    out.push({ name, phrases, filters: (raw.filters as Record<string, unknown>) ?? {}, enabled: raw.enabled ?? true });
  }
  return out;
}

export async function listItems(sql: SqlLike): Promise<FleetItem[]> {
  return sql<ItemRow[]>`SELECT name, phrases, filters, enabled FROM fleet_items ORDER BY name`;
}

/** Writes the items given and leaves the rest alone; an item goes away by `enabled: false`, never by omission. */
export async function upsertItems(sql: SqlLike, items: FleetItem[]): Promise<FleetItem[]> {
  for (const i of items) {
    await sql`
      INSERT INTO fleet_items (name, phrases, filters, enabled)
      VALUES (${i.name}, ${sql.json(i.phrases)}, ${sql.json(i.filters as JSONValue)}, ${i.enabled})
      ON CONFLICT (name) DO UPDATE SET phrases = EXCLUDED.phrases, filters = EXCLUDED.filters, enabled = EXCLUDED.enabled`;
  }
  return listItems(sql);
}

// ── Settings ─────────────────────────────────────────────────────────────────

type NumericKey = keyof typeof FLEET_SETTINGS_DEFAULTS;

/** Inclusive bounds per numeric key; the console's limits where it had one. */
export const SETTING_BOUNDS: Record<NumericKey, readonly [number, number]> = {
  per_day_default: [1, 24],
  budget_minutes: [1, 1440],
  lease_minutes: [1, 180],
  task_max_minutes: [1, 240],
  // Held polls go through the Cloudflare proxy, which cuts an origin answer
  // off at 100 s.
  poll_hold_seconds: [1, 90],
  familiar_days: [0, 90],
  start_fresh_hours: [0, 48],
  quarantine_hours: [0, 720],
  quarantine_probe_hours: [1, 168],
  // At least the city log's longest window (720 h) and the quarantine's.
  retention_days: [30, 730],
  // A static ISP exit is one IP; two accounts on it is what the vendor's
  // pairs were bought for.
  max_accounts_per_proxy: [1, 10],
};

// What Facebook's own filters accept (the vendored monitor's enums), and the
// monitor's duration syntax. `start_at` is deliberately absent: the fleet has
// no sweep time, which is the point of it.
const DATE_LISTED = ['all', 'last 24 hours', 'last 7 days', 'last 30 days'];
const DELIVERY_METHODS = ['all', 'local_pick_up', 'shipping'];
const DURATION = /^\d+[smhd]$/;
const MAX_PROMPT = 20_000;

type Check = (v: unknown) => string | null;
const choice = (options: string[]): Check => (v) => (typeof v === 'string' && options.includes(v) ? null : `must be one of: ${options.join(', ')}`);
const choiceOrList = (options: string[]): Check => (v) => {
  if (Array.isArray(v)) {
    if (v.length < 1 || v.length > 10) return 'must list 1 to 10 values';
    return v.every((x) => typeof x === 'string' && options.includes(x)) ? null : `each must be one of: ${options.join(', ')}`;
  }
  return choice(options)(v);
};
const int = (lo: number, hi: number): Check => (v) => (isInt(v, lo, hi) ? null : `must be a whole number from ${lo} to ${hi}`);
const bool: Check = (v) => (typeof v === 'boolean' ? null : 'must be true or false');
const duration: Check = (v) => (typeof v === 'string' && DURATION.test(v.trim()) ? null : 'must be a number and a unit, like 45m or 2h');
const rating: Check = (v) => (typeof v === 'number' && v >= 0 && v <= 5 ? null : 'must be a number from 0 to 5');
const prompt: Check = (v) => (typeof v === 'string' && v.trim() && v.length <= MAX_PROMPT ? null : `must be text of 1 to ${MAX_PROMPT} characters`);

export const SEARCH_FIELDS: Record<string, Check> = {
  date_listed: choiceOrList(DATE_LISTED),
  delivery_method: choice(DELIVERY_METHODS),
  max_results: int(1, 1000),
  search_interval: duration,
  max_search_interval: duration,
  title_prefilter: bool,
  min_seller_rating: rating,
  exclude_unrated_sellers: bool,
  rating: int(1, 5),
  min_unit_count: int(1, 10_000),
  prompt,
  rating_prompt: prompt,
};

export type SettingsPatch = Partial<FleetSettings>;

export function readSettingsPatch(input: unknown): SettingsPatch | Refusal {
  if (!isObject(input)) return bad('expected an object');
  const patch: SettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'search') {
      if (!isObject(value)) return bad('search must be an object');
      const search: FleetSearchSettings = {};
      for (const [k, v] of Object.entries(value)) {
        const check = SEARCH_FIELDS[k];
        if (!check) return bad(`not an editable search setting: ${k}`);
        const err = check(v);
        if (err) return bad(`search.${k} ${err}`);
        search[k] = typeof v === 'string' ? v.trim() : v;
      }
      patch.search = search;
      continue;
    }
    if (!(key in SETTING_BOUNDS)) return bad(`not a setting: ${key}`);
    const [lo, hi] = SETTING_BOUNDS[key as NumericKey];
    if (!isInt(value, lo, hi)) return bad(`${key} must be a whole number from ${lo} to ${hi}`);
    patch[key as NumericKey] = value;
  }
  if (Object.keys(patch).length === 0) return bad('nothing to save');
  return patch;
}

/** The defaults with every saved row on top; `search` is empty until imported. */
export async function loadSettings(sql: SqlLike): Promise<FleetSettings> {
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM fleet_settings`;
  const out: FleetSettings = { ...FLEET_SETTINGS_DEFAULTS, search: {} };
  for (const r of rows) {
    if (r.key === 'search') { if (isObject(r.value)) out.search = r.value; continue; }
    if (r.key in SETTING_BOUNDS && typeof r.value === 'number') out[r.key as NumericKey] = r.value;
  }
  return out;
}

/** Saves the patch; `search` keys merge into the saved ones, so one change does not drop the rest. */
export async function saveSettings(sql: Sql, patch: SettingsPatch, userId: string): Promise<FleetSettings> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'search') {
        const current = (await loadSettings(tx)).search;
        const merged = { ...current, ...(value as FleetSearchSettings) };
        await tx`
          INSERT INTO fleet_settings (key, value, updated_by, updated_at)
          VALUES ('search', ${tx.json(merged as JSONValue)}, ${userId}, NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
        continue;
      }
      await tx`
        INSERT INTO fleet_settings (key, value, updated_by, updated_at)
        VALUES (${key}, ${tx.json(value as number)}, ${userId}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
    }
    return loadSettings(tx);
  });
}
