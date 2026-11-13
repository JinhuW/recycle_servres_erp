import { describe, expect, it } from 'vitest';
import type { FbChatConfigEntry, FbChatKnownConfigField } from '@recycle-erp/shared';
import {
  accountsThatDiffer, draftOf, groupSettings, hasOwnValue, itemKeys, orphanEntries, parseDraft, rangeAfter,
  rangeWrites, settingProblem,
} from './SettingsModel';

const int = (key: string, def: number, min: number, max: number): FbChatKnownConfigField =>
  ({ key, label: key, type: 'integer', default: def, min, max, versions: ['0.3.0'] });
const PAUSED: FbChatKnownConfigField = { key: 'paused', label: 'Paused', type: 'boolean', default: false, versions: ['0.3.0'] };
const PACE: FbChatKnownConfigField = { key: 'typingPace', label: 'Typing pace', type: 'number', default: 1, min: 0.5, max: 3, versions: ['0.3.0'] };
const LO = int('inboxRefreshMinSec', 20, 10, 7200);
const HI = int('inboxRefreshMaxSec', 40, 10, 7200);
const QUIET = int('quietThreadMin', 15, 1, 1440);
const POLL = int('configPollSec', 60, 30, 3600);
const GAP = int('minSendIntervalSec', 20, 10, 600);
const NEW: FbChatKnownConfigField = { key: 'greeting', label: 'Greeting', type: 'string', default: '', versions: ['0.4.0'] };

const entry = (key: string, account_id: number | null, value: unknown): FbChatConfigEntry =>
  ({ key, account_id, value, updated_at: '2026-11-12T00:00:00Z', updated_by: null });

const ids = (fields: FbChatKnownConfigField[]) => {
  const g = groupSettings(fields);
  return { send: g.send.map((i) => i.id), read: g.read.map((i) => i.id), adv: g.adv.map((i) => i.id) };
};

describe('groupSettings', () => {
  it('puts the reported fields in the page order, whatever order they arrive in', () => {
    expect(ids([POLL, NEW, QUIET, HI, PACE, LO, GAP, PAUSED])).toEqual({
      send: ['paused', 'minSendIntervalSec', 'typingPace'],
      read: ['inboxRefresh', 'quietThreadMin'],
      adv: ['configPollSec', 'greeting'],
    });
  });

  it('joins the two refresh fields into one range item', () => {
    const [range] = groupSettings([LO, HI]).read;
    expect(range).toMatchObject({ kind: 'range', lo: LO, hi: HI });
    expect(itemKeys(range!)).toEqual(['inboxRefreshMinSec', 'inboxRefreshMaxSec']);
  });

  it('leaves out a known key nobody reports', () => {
    expect(ids([PAUSED])).toEqual({ send: ['paused'], read: [], adv: [] });
  });

  it('shows a field it has never heard of under Advanced, with the extension’s own copy', () => {
    expect(groupSettings([NEW]).adv).toEqual([{ kind: 'field', id: 'greeting', field: NEW, known: false }]);
  });

  it('treats one refresh end alone as an ordinary field', () => {
    expect(ids([LO, QUIET])).toEqual({ send: [], read: ['quietThreadMin'], adv: ['inboxRefreshMinSec'] });
  });
});

describe('whose value a row shows', () => {
  const entries = [entry('paused', 4, true), entry('minSendIntervalSec', 2, 45), entry('inboxRefreshMaxSec', 2, 90), entry('inboxRefreshMinSec', 7, 30), entry('paused', null, false)];

  it('knows when the scope holds its own value', () => {
    expect(hasOwnValue(entries, ['paused'], 4)).toBe(true);
    expect(hasOwnValue(entries, ['paused'], 2)).toBe(false);
    expect(hasOwnValue(entries, ['paused'], null)).toBe(true);
    expect(hasOwnValue(entries, ['minSendIntervalSec'], null)).toBe(false);
    expect(hasOwnValue(entries, ['inboxRefreshMinSec', 'inboxRefreshMaxSec'], 2)).toBe(true);
  });

  it('counts each account once, however many of the keys it overrides', () => {
    expect(accountsThatDiffer(entries, ['paused'])).toBe(1);
    expect(accountsThatDiffer(entries, ['inboxRefreshMinSec', 'inboxRefreshMaxSec'])).toBe(2);
    expect(accountsThatDiffer(entries, ['typingPace'])).toBe(0);
  });

  it('finds the scope’s values for keys no extension reports', () => {
    const page = { fields: [PAUSED], entries: [...entries, entry('oldKnob', null, 3), entry('oldKnob', 4, 5)] };
    expect(orphanEntries(page, null).map((e) => [e.key, e.value])).toEqual([['oldKnob', 3]]);
    expect(orphanEntries(page, 4).map((e) => [e.key, e.value])).toEqual([['oldKnob', 5]]);
    expect(orphanEntries(page, 2).map((e) => e.key)).toEqual(['minSendIntervalSec', 'inboxRefreshMaxSec']);
  });
});

describe('the inbox refresh range', () => {
  const now = { lo: 20, hi: 40 };

  it('raises the longest when the shortest passes it', () => {
    expect(rangeAfter(now, { lo: 60 })).toEqual({ lo: 60, hi: 60 });
    expect(rangeWrites(now, rangeAfter(now, { lo: 60 }))).toEqual([
      { key: 'inboxRefreshMinSec', value: 60 }, { key: 'inboxRefreshMaxSec', value: 60 },
    ]);
  });

  it('holds the longest at the shortest when it is typed lower', () => {
    expect(rangeAfter(now, { hi: 5 })).toEqual({ lo: 20, hi: 20 });
    expect(rangeWrites({ lo: 20, hi: 20 }, rangeAfter({ lo: 20, hi: 20 }, { hi: 5 }))).toEqual([]);
  });

  it('writes only the end that changed', () => {
    expect(rangeWrites(now, rangeAfter(now, { lo: 30 }))).toEqual([{ key: 'inboxRefreshMinSec', value: 30 }]);
    expect(rangeWrites(now, rangeAfter(now, { hi: 90 }))).toEqual([{ key: 'inboxRefreshMaxSec', value: 90 }]);
  });
});

describe('checking a value before it is saved', () => {
  it('passes what the shared check passes', () => {
    expect(settingProblem(GAP, 20)).toBeNull();
    expect(settingProblem(PACE, 1.5)).toBeNull();
    expect(settingProblem(PAUSED, true)).toBeNull();
    expect(settingProblem(NEW, 'hi')).toBeNull();
  });

  it('words each refusal', () => {
    expect(settingProblem(GAP, 5)).toEqual({ key: 'fbcs_errMin', vars: { min: 10 } });
    expect(settingProblem(GAP, 601)).toEqual({ key: 'fbcs_errMax', vars: { max: 600 } });
    expect(settingProblem(GAP, 20.5)).toEqual({ key: 'fbcs_errWhole' });
    expect(settingProblem(GAP, Number.NaN)).toEqual({ key: 'fbcs_errNumber' });
    expect(settingProblem(PAUSED, 'yes')).toEqual({ key: 'fbcs_errBoolean' });
    expect(settingProblem({ ...NEW, options: ['a', 'b'] }, 'c')).toEqual({ key: 'fbcs_errOption', vars: { options: 'a, b' } });
    expect(settingProblem(NEW, 3)).toEqual({ key: 'fbcs_errText' });
  });

  it('reads what was typed as the field’s type', () => {
    expect(parseDraft(GAP, ' 45 ')).toEqual({ value: 45 });
    expect(parseDraft(GAP, '')).toEqual({ error: { key: 'fbcs_errNumber' } });
    expect(parseDraft(NEW, 'hello')).toEqual({ value: 'hello' });
    const json: FbChatKnownConfigField = { key: 'x', label: 'X', type: 'json', default: {}, versions: [] };
    expect(parseDraft(json, '{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseDraft(json, '{a')).toEqual({ error: { key: 'fbcs_errJson' } });
    expect(draftOf(json, { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(draftOf(GAP, 45)).toBe('45');
  });
});
