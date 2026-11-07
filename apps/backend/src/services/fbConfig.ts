import { FB_SELLER_DEFAULT_SETTINGS, type FbSellerSettings, type FbSettingsChange } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// The seller domain's one source of configuration: the single
// fb_seller_settings row. Callers read it per tick or per run and never cache
// it past one, so a manager's save takes effect without a restart.

export async function loadFbSellerSettings(sql: SqlLike): Promise<FbSellerSettings> {
  return (await loadFbSellerSettingsRow(sql)).value;
}

export async function loadFbSellerSettingsRow(sql: SqlLike): Promise<{ value: FbSellerSettings; version: number }> {
  const [row] = await sql<{ value: FbSellerSettings; version: number }[]>`
    SELECT value, version FROM fb_seller_settings WHERE id = 1`;
  if (!row) throw new Error('fb_seller_settings has no row; migration 0232 seeds it');
  return row;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Lower bounds tighter than the general ≥ 0, keyed by field path. */
const MINIMUMS: Record<string, number> = {
  'pacing.send_gap_seconds': 10,
  'pacing.ad_action_gap_minutes': 5,
  'pacing.inbox_every_minutes': 2,
};
const HHMM = /^\d{2}:\d{2}$/;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'empty';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'string' ? 'text' : `a ${typeof v}`;
}

/**
 * Walks the value against the seeded defaults' shape, so a field the type
 * doesn't know, or one it lacks, is refused by name rather than stored.
 * Answers the first problem as `<field path>: <reason in words>`.
 */
export function validateFbSellerSettings(input: unknown): { ok: true; value: FbSellerSettings } | { ok: false; detail: string } {
  const problem = check(input, FB_SELLER_DEFAULT_SETTINGS, '');
  return problem ? { ok: false, detail: problem } : { ok: true, value: input as FbSellerSettings };
}

function check(value: unknown, shape: unknown, path: string): string | null {
  const name = path || 'settings';
  if (path === 'alerts.telegram_chat_id') {
    if (value === null) return null;
    if (typeof value !== 'string' || value.trim() === '') return `${name}: must be a Telegram chat id, or empty to turn Telegram off`;
    if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/.test(value.trim())) return `${name}: must be a numeric chat id or an @channel name`;
    return null;
  }
  if (typeof shape === 'boolean') return typeof value === 'boolean' ? null : `${name}: must be on or off, not ${describe(value)}`;
  if (typeof shape === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return `${name}: must be a whole number`;
    if (path.endsWith('_pct')) return value >= 1 && value <= 100 ? null : `${name}: must be a percentage from 1 to 100`;
    const min = MINIMUMS[path] ?? 0;
    return value >= min ? null : `${name}: must be at least ${min}`;
  }
  if (typeof shape === 'string') {
    if (typeof value !== 'string') return `${name}: must be text, not ${describe(value)}`;
    if (path === 'active_hours.tz') return validTimeZone(value) ? null : `${name}: "${value}" is not a time zone name such as America/Denver`;
    if (path === 'active_hours.start' || path === 'active_hours.end') {
      const [h, m] = value.split(':').map(Number);
      return HHMM.test(value) && h! < 24 && m! < 60 ? null : `${name}: must be a time as HH:MM, such as 08:00`;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${name}: must be a group of settings, not ${describe(value)}`;
  const want = shape as Record<string, unknown>;
  const got = value as Record<string, unknown>;
  for (const k of Object.keys(got)) {
    if (!(k in want)) return `${path ? `${path}.` : ''}${k}: is not a setting`;
  }
  for (const k of Object.keys(want)) {
    const sub = path ? `${path}.${k}` : k;
    if (!(k in got)) return `${sub}: is missing`;
    const p = check(got[k], want[k], sub);
    if (p) return p;
  }
  if (path === 'active_hours' && got.start === got.end) return 'active_hours: start and end are the same time, which leaves no hours';
  return null;
}

// ─── Save and history ─────────────────────────────────────────────────────────

export type SaveOutcome =
  | { ok: true; value: FbSellerSettings; version: number }
  | { ok: false; status: 409 | 422; error: 'stale_settings' | 'bad_settings'; detail: string };

/** Optimistic save: `version` must be the one the editor opened, or it is stale. */
export async function saveFbSellerSettings(tx: SqlLike, input: unknown, version: unknown, userId: string): Promise<SaveOutcome> {
  const v = validateFbSellerSettings(input);
  if (!v.ok) return { ok: false, status: 422, error: 'bad_settings', detail: v.detail };
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, status: 422, error: 'bad_settings', detail: 'version: must be the version the settings were opened at' };
  }
  const [cur] = await tx<{ value: FbSellerSettings; version: number }[]>`
    SELECT value, version FROM fb_seller_settings WHERE id = 1 FOR UPDATE`;
  if (!cur || cur.version !== version) {
    return { ok: false, status: 409, error: 'stale_settings', detail: 'Someone saved the settings since you opened them.' };
  }
  const value = { ...v.value, alerts: { telegram_chat_id: v.value.alerts.telegram_chat_id?.trim() ?? null } };
  const next = cur.version + 1;
  await tx`
    UPDATE fb_seller_settings
       SET value = ${tx.json(value)}, version = ${next}, updated_by = ${userId}, updated_at = NOW()
     WHERE id = 1`;
  await tx`
    INSERT INTO fb_seller_settings_history (version, before, after, changed_by)
    VALUES (${next}, ${tx.json(cur.value)}, ${tx.json(value)}, ${userId})`;
  return { ok: true, value, version: next };
}

export async function listSettingsHistory(sql: SqlLike, beforeId: number | null, limit: number): Promise<FbSettingsChange[]> {
  const rows = await sql<(Omit<FbSettingsChange, 'changed_at'> & { id: string | number; changed_at: Date })[]>`
    SELECT h.id, h.version, h.before, h.after, h.changed_by, u.name AS changed_by_name, h.changed_at
      FROM fb_seller_settings_history h
      LEFT JOIN users u ON u.id = h.changed_by
     WHERE ${beforeId === null ? sql`TRUE` : sql`h.id < ${beforeId}`}
     ORDER BY h.id DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id), changed_at: r.changed_at.toISOString() }));
}
