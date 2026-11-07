import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  EvalExpectation, FbAd, FbAdInput, FbAdState, FbAgentEvalCase, FbAgentEvalRun, FbAgentProfile,
  FbAgentEvalRunDetail, FbAgentProfileRow, FbEvalCompare, FbMessage, FbPhoto, FbPhotoPool, FbPlacement, FbPlacementState, FbSellerAccount,
  FbSellerRole, FbSellerSettings, FbSellerSummary, FbSendState, FbSettingsChange, FbThreadDetail, FbThreadRow,
  FbShadowPage, ParamSchema, RegistryEntry,
} from '@recycle-erp/shared';
import { api } from './api';
import { handleFetchError } from './errorToast';

// ─── Leads ▸ Facebook: the client ─────────────────────────────────────────────
// Every call to /api/fb-seller and /api/fb-agent goes through here. Until the
// seller backend lands, a dev build can answer /api/fb-seller from an in-memory
// fake of its routes (lib/fbSellerMock.ts), switched on with
// localStorage['erp.fbSeller.mock'] = '1'. A production build never loads it.

export type Paged<T> = { rows: T[]; next: string | null };

// C adds `ceiling_usd` to FbThreadRow in shared/fbSeller.ts (CONTRACTS §9);
// until it lands the list row carries it here.

/** The thread list row with the ceiling the Needs human table shows beside the offer. */
export type FbThreadListRow = FbThreadRow & { ceiling_usd?: number | null };
export type FbPlaceResult = { placements: FbPlacement[]; refused: { account_no: number; location: string; reason: string }[] };
export type FbUploadResult = { added: FbPhoto[]; refused: { name: string; reason: string }[] };

type Transport = Pick<typeof api, 'get' | 'post' | 'put' | 'patch' | 'delete' | 'upload'>;

const S = '/api/fb-seller';
const A = '/api/fb-agent';

const MOCK_KEY = 'erp.fbSeller.mock';
export function fbMockOn(): boolean {
  if (!import.meta.env.DEV) return false;
  try { return localStorage.getItem(MOCK_KEY) === '1'; } catch { return false; }
}

let mock: Promise<Transport> | null = null;
// Only the seller routes are faked; /api/fb-agent always reaches the backend.
function transport(path: string): Promise<Transport> {
  if (!path.startsWith(S) || !fbMockOn()) return Promise.resolve(api);
  mock ??= import('./fbSellerMock').then(m => m.fbMockTransport);
  return mock;
}

const get = async <T,>(path: string) => (await transport(path)).get<T>(path);
const post = async <T,>(path: string, body: unknown = {}) => (await transport(path)).post<T>(path, body);
const put = async <T,>(path: string, body: unknown) => (await transport(path)).put<T>(path, body);
const patch = async <T,>(path: string, body: unknown) => (await transport(path)).patch<T>(path, body);
const del = async <T,>(path: string) => (await transport(path)).delete<T>(path);
const upload = async <T,>(path: string, form: FormData) => (await transport(path)).upload<T>(path, form);

/** A query string from the set values only. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}


export const fbSellerApi = {
  summary: () => get<FbSellerSummary>(`${S}/summary`),
  settings: () => get<{ value: FbSellerSettings; version: number }>(`${S}/settings`),
  saveSettings: (value: FbSellerSettings, version: number) => put<{ value: FbSellerSettings; version: number }>(`${S}/settings`, { value, version }),
  settingsHistory: (cursor?: string | null) => get<Paged<FbSettingsChange>>(`${S}/settings/history${qs({ cursor })}`),
  accounts: () => get<{ rows: FbSellerAccount[] }>(`${S}/accounts`),
  patchAccount: (no: number, body: { role?: FbSellerRole; agent_on?: boolean; agent_profile_id?: number | null }) =>
    patch<FbSellerAccount>(`${S}/accounts/${no}`, body),
  pools: () => get<{ rows: FbPhotoPool[] }>(`${S}/pools`),
  createPool: (name: string, note?: string) => post<FbPhotoPool>(`${S}/pools`, { name, note }),
  patchPool: (id: number, body: { name?: string; note?: string; archived?: boolean }) => patch<FbPhotoPool>(`${S}/pools/${id}`, body),
  photos: (poolId: number, used: 'all' | 'used' | 'unused', cursor?: string | null) =>
    get<Paged<FbPhoto>>(`${S}/pools/${poolId}/photos${qs({ used, cursor })}`),
  uploadPhotos: (poolId: number, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    return upload<FbUploadResult>(`${S}/pools/${poolId}/photos`, form);
  },
  deletePhoto: (id: number) => del<{ ok: true }>(`${S}/photos/${id}`),
  ads: (state?: FbAdState) => get<{ rows: FbAd[] }>(`${S}/ads${qs({ state })}`),
  ad: (id: number) => get<FbAd>(`${S}/ads/${id}`),
  createAd: (input: FbAdInput) => post<FbAd>(`${S}/ads`, input),
  patchAd: (id: number, body: Partial<FbAdInput> & { state?: FbAdState }) => patch<FbAd>(`${S}/ads/${id}`, body),
  place: (id: number, account_nos: number[], locations: string[]) => post<FbPlaceResult>(`${S}/ads/${id}/place`, { account_nos, locations }),
  placements: (f: { state?: FbPlacementState; account_no?: number; cursor?: string | null } = {}) =>
    get<Paged<FbPlacement>>(`${S}/placements${qs(f)}`),
  renew: (id: number) => post<FbPlacement>(`${S}/placements/${id}/renew`),
  remove: (id: number) => post<FbPlacement>(`${S}/placements/${id}/remove`),
  resolve: (id: number, live: boolean, fb_listing_id?: string) =>
    post<FbPlacement>(`${S}/placements/${id}/resolve`, fb_listing_id ? { live, fb_listing_id } : { live }),
  threads: (view: 'needs_human' | 'inbox' | 'closed', f: { account_no?: number; q?: string; cursor?: string | null } = {}) =>
    get<Paged<FbThreadListRow>>(`${S}/threads${qs({ view, ...f })}`),
  thread: (id: number) => get<FbThreadDetail>(`${S}/threads/${id}`),
  reply: (id: number, body: string) => post<FbMessage>(`${S}/threads/${id}/reply`, { body }),
  takeOver: (id: number) => post<FbThreadDetail>(`${S}/threads/${id}/take-over`),
  handBack: (id: number) => post<FbThreadDetail>(`${S}/threads/${id}/hand-back`),
  close: (id: number, outcome: 'won' | 'lost', note?: string) => post<FbThreadDetail>(`${S}/threads/${id}/close`, { outcome, note }),
  read: (id: number) => post<{ ok: true }>(`${S}/threads/${id}/read`),
  saveCase: (id: number, name: string, expected: EvalExpectation) => post<{ case_id: number }>(`${S}/threads/${id}/save-case`, { name, expected }),
};

export type FbProfileEdit = Partial<Pick<FbAgentProfile, 'prompts' | 'skills' | 'rules' | 'models' | 'notes'>>;

export const fbAgentApi = {
  registry: () => get<{ rules: RegistryEntry[]; skills: RegistryEntry[] }>(`${A}/registry`),
  profiles: () => get<{ rows: FbAgentProfileRow[] }>(`${A}/profiles`),
  profile: (id: number) => get<FbAgentProfileRow>(`${A}/profiles/${id}`),
  draft: (fromId: number) => post<FbAgentProfileRow>(`${A}/profiles/${fromId}/draft`),
  patchProfile: (id: number, body: FbProfileEdit) => patch<FbAgentProfileRow>(`${A}/profiles/${id}`, body),
  promote: (id: number, to: 'candidate' | 'active') => post<FbAgentProfileRow>(`${A}/profiles/${id}/promote`, { to }),
  retire: (id: number) => post<FbAgentProfileRow>(`${A}/profiles/${id}/retire`),
  shadow: (profileId: number | null, cursor?: string | null) => get<FbShadowPage>(`${A}/shadow${qs({ profile_id: profileId, cursor })}`),
  cases: () => get<{ rows: FbAgentEvalCase[] }>(`${A}/cases`),
  archiveCase: (id: number) => del<{ ok: true }>(`${A}/cases/${id}`),
  evals: (profileId?: number) => get<{ rows: FbAgentEvalRun[] }>(`${A}/evals${qs({ profile_id: profileId })}`),
  runEval: (profileId: number) => post<FbAgentEvalRun>(`${A}/evals`, { profile_id: profileId }),
  evalRun: (id: number) => get<FbAgentEvalRunDetail>(`${A}/evals/${id}`),
  compare: (a: number, b: number) => get<FbEvalCompare>(`${A}/evals/compare${qs({ a, b })}`),
};

// ─── Polling ──────────────────────────────────────────────────────────────────

/**
 * Loads on mount and whenever `deps` change, then every `ms` while the tab is
 * visible (null: once). The first failure gets the error dialog; a poll that
 * fails after that keeps what is on screen, since the next one usually lands.
 */
export function usePolled<T>(load: () => Promise<T>, ms: number | null, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const gen = useRef(0);
  const shown = useRef(false);

  const reload = useCallback(() => {
    const mine = ++gen.current;
    return loadRef.current().then(
      r => { if (mine === gen.current) { setData(r); setFailed(false); shown.current = true; } },
      err => {
        if (mine !== gen.current) return;
        if (!shown.current) { setFailed(true); handleFetchError(err); }
      },
    );
  }, []);

  useEffect(() => {
    shown.current = false;
    setData(null);
    void reload();
    if (ms === null) return () => { gen.current++; };
    const tick = () => { if (document.visibilityState === 'visible') void reload(); };
    const handle = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      gen.current++;
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload, ms, ...deps]);

  return { data, setData, reload, failed };
}

// ─── Summary (sidebar badge and tab counts) ───────────────────────────────────
// One read shared by every reader, every 60 s while visible; a write on the
// page fires fbSellerChanged() for an immediate one.

const CHANGED = 'fb-seller-changed';
const SUMMARY_MS = 60_000;
let summary: FbSellerSummary | null = null;
let reading = false;
let stale = false;
let timer = 0;
const readers = new Set<() => void>();

function readSummary() {
  if (reading) { stale = true; return; }
  reading = true;
  fbSellerApi.summary()
    // A badge that fails to load stays as it was; it is never worth a dialog.
    .then(r => { summary = r; for (const l of readers) l(); }, () => {})
    .finally(() => {
      reading = false;
      if (stale) { stale = false; readSummary(); }
    });
}
const readIfVisible = () => { if (document.visibilityState === 'visible') readSummary(); };

function watchSummary(onChange: () => void) {
  if (readers.size === 0) {
    window.addEventListener(CHANGED, readSummary);
    document.addEventListener('visibilitychange', readIfVisible);
    timer = window.setInterval(readIfVisible, SUMMARY_MS);
  }
  readers.add(onChange);
  if (!reading) readSummary();
  return () => {
    readers.delete(onChange);
    if (readers.size === 0) {
      window.removeEventListener(CHANGED, readSummary);
      document.removeEventListener('visibilitychange', readIfVisible);
      window.clearInterval(timer);
    }
  };
}
const watchNothing = () => () => {};

export const fbSellerChanged = () => window.dispatchEvent(new Event(CHANGED));

export function useFbSellerSummary(enabled = true): FbSellerSummary | null {
  const s = useSyncExternalStore(enabled ? watchSummary : watchNothing, () => summary);
  return enabled ? s : null;
}

/** Threads waiting on a manager. Managers only; the API refuses anyone else. */
export function useFbNeedsHumanCount(enabled: boolean): number {
  return useFbSellerSummary(enabled)?.needs_human ?? 0;
}

// ─── Rules the pages share ────────────────────────────────────────────────────

/** Closing deals first, then whoever has waited longest. */
export function sortNeedsHuman<T extends Pick<FbThreadRow, 'stage' | 'human_at' | 'id'>>(rows: readonly T[]): T[] {
  const at = (r: T) => (r.human_at ? Date.parse(r.human_at) : Number.POSITIVE_INFINITY);
  return [...rows].sort((a, b) =>
    Number(b.stage === 'closing') - Number(a.stage === 'closing') || at(a) - at(b) || a.id - b.id);
}

/**
 * Every round's offer for a ceiling, as lib/fbOffer.ts computes it on the
 * server (CONTRACTS §6.6): the opening share plus a step per round, never
 * above the ceiling, rounded to the dollar.
 */
export function offerLadder(ceiling: number, o: FbSellerSettings['offer']): number[] {
  return Array.from({ length: Math.max(1, o.max_rounds) }, (_, r) =>
    Math.min(ceiling, Math.round((ceiling * (o.opening_pct + o.step_pct * r)) / 100)));
}

/** The chip tone for an outbound message's send state. */
export const SEND_STATE_TONE: Record<FbSendState, string> = {
  queued: 'muted', held: 'warn', sending: 'info', sent: 'pos', uncertain: 'warn', failed: 'neg',
};

/** Whether an account can still carry a thread: it exists and is a seller that is not retired. */
export function threadStranded(accountNo: number | null, accounts: readonly FbSellerAccount[] | null): boolean {
  if (accountNo === null) return true;
  if (!accounts) return false;
  const a = accounts.find(x => x.account_no === accountNo);
  return !a || a.role !== 'seller' || a.account_state === 'RETIRED';
}

// ─── Settings validation (mirrors fbConfig.ts, CONTRACTS §2.1) ─────────────────

export type FbSettingsProblem = { path: string; key: string; vars?: Record<string, string | number> };

const PCT_FIELDS = new Set(['offer.opening_pct', 'offer.step_pct']);
const MINIMUMS: Record<string, number> = {
  'pacing.send_gap_seconds': 10,
  'pacing.ad_action_gap_minutes': 5,
  'pacing.inbox_every_minutes': 2,
};

export function validTimeZone(tz: string): boolean {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Every problem in a settings value; empty when it would save. `key` is an i18n key. */
export function validateFbSettings(v: FbSellerSettings): FbSettingsProblem[] {
  const out: FbSettingsProblem[] = [];
  const numbers: [string, unknown][] = [
    ...Object.entries(v.pacing).map(([k, n]) => [`pacing.${k}`, n] as [string, unknown]),
    ...Object.entries(v.offer).map(([k, n]) => [`offer.${k}`, n] as [string, unknown]),
    ...Object.entries(v.agent).map(([k, n]) => [`agent.${k}`, n] as [string, unknown]),
    ['photos.low_pool_warning', v.photos.low_pool_warning],
  ];
  for (const [path, n] of numbers) {
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) { out.push({ path, key: 'fbs_err_whole' }); continue; }
    if (PCT_FIELDS.has(path)) {
      if (n < 1 || n > 100) out.push({ path, key: 'fbs_err_pct' });
    } else if (n < (MINIMUMS[path] ?? 0)) {
      out.push({ path, key: 'fbs_err_min', vars: { min: MINIMUMS[path] ?? 0 } });
    }
  }
  for (const k of ['start', 'end'] as const) {
    if (!/^\d{2}:\d{2}$/.test(v.active_hours[k])) out.push({ path: `active_hours.${k}`, key: 'fbs_err_hhmm' });
  }
  if (!validTimeZone(v.active_hours.tz)) out.push({ path: 'active_hours.tz', key: 'fbs_err_tz' });
  return out;
}

/** The settings with one field at `path` replaced, untouched otherwise. */
export function setSettingsField(v: FbSellerSettings, path: string, value: unknown): FbSellerSettings {
  const [group, field] = path.split('.') as [keyof FbSellerSettings, string | undefined];
  if (!field) return { ...v, [group]: value };
  return { ...v, [group]: { ...(v[group] as Record<string, unknown>), [field]: value } };
}

/** The fields two settings values differ in, as dotted paths, for the history. */
export function settingsDiff(before: FbSellerSettings | null, after: FbSellerSettings): { path: string; from: unknown; to: unknown }[] {
  const flat = (v: FbSellerSettings | null) => {
    const m = new Map<string, unknown>();
    if (!v) return m;
    for (const [g, val] of Object.entries(v)) {
      if (val && typeof val === 'object') for (const [k, x] of Object.entries(val)) m.set(`${g}.${k}`, x);
      else m.set(g, val);
    }
    return m;
  };
  const a = flat(before);
  const b = flat(after);
  const out: { path: string; from: unknown; to: unknown }[] = [];
  for (const [k, to] of b) if (JSON.stringify(a.get(k)) !== JSON.stringify(to)) out.push({ path: k, from: a.get(k), to });
  return out;
}

// ─── Rule and skill params (CONTRACTS §6.3: checked before a version leaves draft) ──

/** The params that break their schema, by name; empty when they all fit. */
export function paramProblems(params: Record<string, unknown>, schema: ParamSchema | null): string[] {
  if (!schema) return [];
  const bad: string[] = [];
  for (const [k, f] of Object.entries(schema.properties)) {
    const v = params[k];
    if (v === undefined || v === null) { if (schema.required?.includes(k)) bad.push(k); continue; }
    if (f.type === 'number' || f.type === 'integer') {
      const ok = typeof v === 'number' && Number.isFinite(v) && (f.type === 'number' || Number.isInteger(v))
        && (f.minimum === undefined || v >= f.minimum) && (f.maximum === undefined || v <= f.maximum);
      if (!ok) bad.push(k);
    } else if (f.type === 'boolean') {
      if (typeof v !== 'boolean') bad.push(k);
    } else if (f.type === 'string') {
      if (typeof v !== 'string') bad.push(k);
    } else if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || (f.items.enum && !f.items.enum.includes(x)))) {
      bad.push(k);
    }
  }
  return bad;
}
