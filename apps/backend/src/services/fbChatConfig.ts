import { createHash } from 'node:crypto';
import type { FbChatConfigAnswer, FbChatConfigField } from '@recycle-erp/shared';
import type postgres from 'postgres';
import type { SqlLike } from '../db';

// Settings for the chat bridge extensions. Each extension reports the fields
// it understands and gets back the values set on Settings ▸ Chat bridge. The
// ERP keeps no list of its own: the page's form is whatever the extensions
// last reported.

// A version not heard from in this long no longer adds fields to the page.
const FIELDS_FRESH_DAYS = 90;
// The report repeats every minute per profile; rewriting an unchanged one is
// only worth doing now and then, to keep last_seen_at honest.
const FIELDS_TOUCH_MINUTES = 10;

/** Numeric dotted versions in order; anything unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export async function reportFields(tx: SqlLike, extVersion: string, fields: FbChatConfigField[]): Promise<void> {
  await tx`
    INSERT INTO fb_chat_config_fields (ext_version, fields)
    VALUES (${extVersion}, ${tx.json(fields as unknown as postgres.JSONValue)})
    ON CONFLICT (ext_version) DO UPDATE SET fields = EXCLUDED.fields, last_seen_at = NOW()
     WHERE fb_chat_config_fields.fields IS DISTINCT FROM EXCLUDED.fields
        OR fb_chat_config_fields.last_seen_at < NOW() - make_interval(mins => ${FIELDS_TOUCH_MINUTES})`;
}

/**
 * The values one profile gets: the shared ones, overridden by its own. Keys
 * are sorted so the revision depends only on what the profile would apply.
 */
export async function configFor(tx: SqlLike, accountId: number | null): Promise<FbChatConfigAnswer> {
  const rows = await tx<{ key: string; value: unknown }[]>`
    SELECT key, value FROM fb_chat_config
     WHERE account_id IS NULL OR account_id = ${accountId}
     ORDER BY (account_id IS NOT NULL), key`;
  const merged = new Map<string, unknown>();
  for (const r of rows) merged.set(r.key, r.value);
  const values = Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const rev = createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16);
  return { rev, values };
}

export async function notePickup(tx: SqlLike, accountId: number, rev: string): Promise<void> {
  await tx`
    UPDATE fb_chat_accounts SET config_rev = ${rev}, config_seen_at = NOW()
     WHERE id = ${accountId}`;
}

export type FbChatKnownField = FbChatConfigField & {
  /** Recent extension versions that report this field, newest first. */
  versions: string[];
};

/** Every field a recent extension reports, as the newest version defines it. */
export async function knownFields(sql: SqlLike): Promise<FbChatKnownField[]> {
  const rows = await sql<{ ext_version: string; fields: FbChatConfigField[] }[]>`
    SELECT ext_version, fields FROM fb_chat_config_fields
     WHERE last_seen_at > NOW() - make_interval(days => ${FIELDS_FRESH_DAYS})`;
  rows.sort((a, b) => compareVersions(b.ext_version, a.ext_version));
  const byKey = new Map<string, FbChatKnownField>();
  for (const r of rows) {
    for (const f of r.fields) {
      const known = byKey.get(f.key);
      if (known) known.versions.push(r.ext_version);
      else byKey.set(f.key, { ...f, versions: [r.ext_version] });
    }
  }
  // The order the newest extension lists them in, which is the order it chose.
  return [...byKey.values()];
}

/** Sets a value, or with `value` undefined removes it, back to the default. */
export async function setConfig(
  tx: SqlLike, accountId: number | null, key: string, value: unknown, userId: string,
): Promise<void> {
  if (value === undefined) {
    await tx`DELETE FROM fb_chat_config WHERE account_id IS NOT DISTINCT FROM ${accountId} AND key = ${key}`;
    return;
  }
  await tx`
    INSERT INTO fb_chat_config (account_id, key, value, updated_by)
    VALUES (${accountId}, ${key}, ${tx.json(value as postgres.JSONValue)}, ${userId})
    ON CONFLICT (account_id, key) DO UPDATE SET
      value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
}
