import {
  fbChatConfigProblem,
  type FbChatConfigEntry, type FbChatConfigField, type FbChatConfigPage, type FbChatKnownConfigField,
} from '@recycle-erp/shared';

// What the Settings tab works out from `GET /config` before it draws anything:
// which card a reported field belongs to, whose value a row shows, and what a
// change to the inbox refresh range has to write. Kept free of React so it can
// be tested as plain functions.

export type SettingsGroup = 'send' | 'read' | 'adv';

export const RANGE_LO_KEY = 'inboxRefreshMinSec';
export const RANGE_HI_KEY = 'inboxRefreshMaxSec';

const SEND_KEYS = ['paused', 'minSendIntervalSec', 'typingPace'];
const QUIET_KEY = 'quietThreadMin';
const POLL_KEY = 'configPollSec';

/**
 * The page's own copy for the settings it knows. The extensions' labels are
 * English only, so these go through i18n as `fbcs_f_<key>` and
 * `fbcs_f_<key>Help`; `unit` is an i18n key too. Bounds and defaults are never
 * here: they are whatever the extensions report.
 */
export const SETTINGS_COPY: Record<string, { unit?: string; step?: number; caution?: boolean }> = {
  // On means replies stop, so its switch wears the warning colour.
  paused: { caution: true },
  minSendIntervalSec: { unit: 'fbcs_unitSec' },
  typingPace: { unit: 'fbcs_unitTimes', step: 0.1 },
  inboxRefresh: { unit: 'fbcs_unitSec' },
  quietThreadMin: { unit: 'fbcs_unitMin' },
  configPollSec: { unit: 'fbcs_unitSec' },
};

export type SettingsItem =
  /** `known`: the page has its own copy for it; otherwise the extension's label and help are shown. */
  | { kind: 'field'; id: string; field: FbChatKnownConfigField; known: boolean }
  | { kind: 'range'; id: 'inboxRefresh'; lo: FbChatKnownConfigField; hi: FbChatKnownConfigField };

const isNumeric = (f: FbChatConfigField) => f.type === 'integer' || f.type === 'number';

/**
 * Sorts the reported fields into the three groups. A known key nobody reports
 * is left out; a field the page has never heard of lands under Advanced, so a
 * new extension setting is editable the day it ships.
 */
export function groupSettings(fields: FbChatKnownConfigField[]): Record<SettingsGroup, SettingsItem[]> {
  const by = new Map(fields.map((f) => [f.key, f]));
  const placed = new Set<string>();
  const take = (key: string): SettingsItem[] => {
    const field = by.get(key);
    if (!field) return [];
    placed.add(key);
    return [{ kind: 'field', id: key, field, known: true }];
  };

  const send = SEND_KEYS.flatMap(take);

  const read: SettingsItem[] = [];
  const lo = by.get(RANGE_LO_KEY);
  const hi = by.get(RANGE_HI_KEY);
  // One half alone, or a half that is not a number, cannot be a range: it
  // falls through to Advanced as an ordinary field.
  if (lo && hi && isNumeric(lo) && isNumeric(hi)) {
    placed.add(RANGE_LO_KEY).add(RANGE_HI_KEY);
    read.push({ kind: 'range', id: 'inboxRefresh', lo, hi });
  }
  read.push(...take(QUIET_KEY));

  const adv = take(POLL_KEY);
  for (const field of fields) {
    if (!placed.has(field.key)) adv.push({ kind: 'field', id: field.key, field, known: false });
  }
  return { send, read, adv };
}

export const itemKeys = (item: SettingsItem): string[] =>
  item.kind === 'range' ? [item.lo.key, item.hi.key] : [item.field.key];

/** True when the scope itself holds a value for any of the keys (null: every account). */
export function hasOwnValue(entries: FbChatConfigEntry[], keys: string[], scope: number | null): boolean {
  return entries.some((e) => e.account_id === scope && keys.includes(e.key));
}

/** How many accounts hold their own value for any of the keys. */
export function accountsThatDiffer(entries: FbChatConfigEntry[], keys: string[]): number {
  return new Set(entries.filter((e) => e.account_id !== null && keys.includes(e.key)).map((e) => e.account_id)).size;
}

/** Values the scope holds for keys no recent extension reports: kept, shown, resettable. */
export function orphanEntries(page: Pick<FbChatConfigPage, 'fields' | 'entries'>, scope: number | null): FbChatConfigEntry[] {
  const reported = new Set(page.fields.map((f) => f.key));
  return page.entries.filter((e) => e.account_id === scope && !reported.has(e.key));
}

export type Range = { lo: number; hi: number };

/** The range after an edit to one end. The longest wait never ends up under the shortest. */
export function rangeAfter(current: Range, edit: Partial<Range>): Range {
  const next = { ...current, ...edit };
  if (next.hi < next.lo) next.hi = next.lo;
  return next;
}

/**
 * The writes that take the range from `current` to `next`. Only an end that
 * changed is written, so an account editing one end does not also pin the
 * other, which it may be following every account for.
 */
export function rangeWrites(current: Range, next: Range): { key: string; value: number }[] {
  const writes: { key: string; value: number }[] = [];
  if (next.lo !== current.lo) writes.push({ key: RANGE_LO_KEY, value: next.lo });
  if (next.hi !== current.hi) writes.push({ key: RANGE_HI_KEY, value: next.hi });
  return writes;
}

export type SettingMessage = { key: string; vars?: Record<string, string | number> };

/**
 * Why `value` cannot be saved to `field`, as an i18n message, or null. The
 * verdict is `fbChatConfigProblem`'s, the same check the server runs; this
 * only words it, since that function answers in English.
 */
export function settingProblem(field: FbChatConfigField, value: unknown): SettingMessage | null {
  if (fbChatConfigProblem(field, value) === null) return null;
  if (field.type === 'boolean') return { key: 'fbcs_errBoolean' };
  if (field.type === 'string') {
    return typeof value === 'string' && field.options
      ? { key: 'fbcs_errOption', vars: { options: field.options.join(', ') } }
      : { key: 'fbcs_errText' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { key: 'fbcs_errNumber' };
  if (field.type === 'integer' && !Number.isInteger(value)) return { key: 'fbcs_errWhole' };
  if (field.min !== undefined && value < field.min) return { key: 'fbcs_errMin', vars: { min: field.min } };
  return { key: 'fbcs_errMax', vars: { max: field.max! } };
}

/** What the input shows for a stored value. */
export function draftOf(field: FbChatConfigField, value: unknown): string {
  if (field.type === 'json') return JSON.stringify(value, null, 2);
  return typeof value === 'string' ? value : String(value);
}

/** Turns what was typed into a value of the field's type. */
export function parseDraft(field: FbChatConfigField, text: string): { value: unknown } | { error: SettingMessage } {
  if (isNumeric(field)) {
    return text.trim() === '' ? { error: { key: 'fbcs_errNumber' } } : { value: Number(text) };
  }
  if (field.type === 'json') {
    try { return { value: JSON.parse(text) }; } catch { return { error: { key: 'fbcs_errJson' } }; }
  }
  return { value: text };
}
