import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  fbChatAccountStatus, fbChatConfigValue,
  type FbChatAccountRow, type FbChatAccountStatus, type FbChatAccountsAnswer, type FbChatConfigPage,
  type FbChatDeviceApproval, type FbChatDeviceRow, type FbChatMessagesAnswer, type FbChatReplyAnswer,
  type FbChatSummary, type FbChatTelegramStatus, type FbChatThreadsAnswer, type FbChatThreadsQuery,
} from '@recycle-erp/shared';
import { api } from './api';
import { handleFetchError } from './errorToast';

// ─── Leads ▸ Facebook ─────────────────────────────────────────────────────────
// The client for /api/fb-chat as the manager page uses it, and the helpers
// its three tabs share. The shapes are in packages/shared/src/fbChat.ts.

const BASE = '/api/fb-chat';
const key = (k: string) => encodeURIComponent(k);

export const fbChatApi = {
  summary: () => api.get<FbChatSummary>(`${BASE}/summary`),

  threads: (query: FbChatThreadsQuery = {}) => {
    const p = new URLSearchParams();
    if (query.account) p.set('account', String(query.account));
    if (query.q) p.set('q', query.q);
    if (query.filter && query.filter !== 'all') p.set('filter', query.filter);
    const qs = p.toString();
    return api.get<FbChatThreadsAnswer>(`${BASE}/threads${qs ? `?${qs}` : ''}`);
  },
  messages: (threadId: number) => api.get<FbChatMessagesAnswer>(`${BASE}/threads/${threadId}/messages`),
  reply: (threadId: number, body: string) =>
    api.post<FbChatReplyAnswer>(`${BASE}/threads/${threadId}/messages`, { body }),
  /** `force`: required for an `uncertain` reply, which may already be on Facebook. */
  retry: (messageId: number, force = false) =>
    api.post<FbChatReplyAnswer>(`${BASE}/messages/${messageId}/retry`, force ? { force: true } : {}),
  markRead: (threadId: number) => api.post<{ ok: true }>(`${BASE}/threads/${threadId}/read`, {}),
  markUnread: (threadId: number) => api.post<{ ok: true }>(`${BASE}/threads/${threadId}/unread`, {}),

  accounts: () => api.get<FbChatAccountsAnswer>(`${BASE}/accounts`),
  renameAccount: (accountId: number, label: string) =>
    api.patch<{ ok: true }>(`${BASE}/accounts/${accountId}`, { label }),

  devices: () => api.get<{ devices: FbChatDeviceRow[] }>(`${BASE}/devices`),
  approveDevice: (deviceId: string, approval: FbChatDeviceApproval = {}) =>
    api.post<{ ok: true }>(`${BASE}/devices/${deviceId}/approve`, approval),
  rejectDevice: (deviceId: string) => api.post<{ ok: true }>(`${BASE}/devices/${deviceId}/reject`, {}),
  /** Disconnects a Chrome. Its account and chats stay. */
  revokeDevice: (deviceId: string) => api.post<{ ok: true }>(`${BASE}/devices/${deviceId}/revoke`, {}),

  config: () => api.get<FbChatConfigPage>(`${BASE}/config`),
  /** `accountId` null sets the value for every account. */
  setConfig: (k: string, accountId: number | null, value: unknown) =>
    api.put<{ ok: true }>(`${BASE}/config/${key(k)}`, { accountId, value }),
  /** Removes a value: an account goes back to every account's, the shared one to the default. */
  resetConfig: (k: string, accountId: number | null) =>
    api.delete<{ ok: true }>(`${BASE}/config/${key(k)}${accountId === null ? '' : `?accountId=${accountId}`}`),

  telegram: () => api.get<FbChatTelegramStatus>(`${BASE}/telegram`),
};

/** The setting every extension reads to stop typing replies. */
export const FB_CHAT_PAUSED_KEY = 'paused';

/**
 * Pauses or resumes one account. An override is only kept while it differs
 * from what the account would get anyway, so Settings does not fill with
 * overrides that say the same as "Every account".
 */
export async function setFbChatAccountPaused(accountId: number, paused: boolean): Promise<void> {
  const page = await fbChatApi.config();
  const inherited = fbChatConfigValue(page, FB_CHAT_PAUSED_KEY, null) === true;
  if (paused === inherited) await fbChatApi.resetConfig(FB_CHAT_PAUSED_KEY, accountId);
  else await fbChatApi.setConfig(FB_CHAT_PAUSED_KEY, accountId, paused);
}

// ── Looks ─────────────────────────────────────────────────────────────────────

// The golden angle keeps any two neighbouring numbers far apart on the wheel,
// however many accounts there are. Account #1 lands on the ERP's own accent.
const HUE_STEP = 137.5;
const FIRST_HUE = 165;

/** The hue an account wears everywhere, from its display number. */
export function fbChatHue(no: number): number {
  return Math.round((FIRST_HUE + (no - 1) * HUE_STEP) % 360);
}

/** A stable hue for a buyer's avatar, from their name. */
export function fbChatNameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** Up to two initials. A name in Chinese gives its first character. */
export function fbChatInitials(name: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map(w => Array.from(w)[0]!.toUpperCase()).join('');
}

export function fbChatAccountName(a: { label: string; fb_uid: string }): string {
  return a.label || a.fb_uid;
}

export function fbChatListingUrl(listingId: string | null): string | null {
  return listingId ? `https://www.facebook.com/marketplace/item/${encodeURIComponent(listingId)}/` : null;
}

export const FB_CHAT_STATUS_KEY: Record<FbChatAccountStatus, string> = {
  running: 'fbc_statusRunning',
  paused: 'fbc_statusPaused',
  login: 'fbc_statusLogin',
  checkpoint: 'fbc_statusCheckpoint',
  stale: 'fbc_statusStale',
};

/** The account's status as of now. Call it on render: silence turns stale without a refetch. */
export function fbChatStatusOf(a: FbChatAccountRow): FbChatAccountStatus {
  return fbChatAccountStatus(a, Date.now());
}

/** True when the account cannot type a reply right now, whatever the reason. */
export function fbChatHoldsReplies(status: FbChatAccountStatus): boolean {
  return status !== 'running';
}

// ── Polling ───────────────────────────────────────────────────────────────────

export const FB_CHAT_POLL_MS = { summary: 30_000, threads: 10_000, messages: 4_000, accounts: 15_000, devices: 10_000 };

export type Polled<T> = {
  /** Null until the first answer. */
  data: T | null;
  /** Reads again now; resolves when the answer is in. */
  reload: () => Promise<void>;
  /** Replaces the data until the next read, for a change the page already knows the outcome of. */
  set: (next: T) => void;
};

/**
 * Reads now, again every `ms` while the tab is visible, and when it comes back
 * into view. `deps` are what the read depends on: a change reads again and
 * drops any answer still on its way for the old ones. The first failure after
 * a change opens the usual error dialog; a failed re-read keeps what is shown.
 */
export function usePolled<T>(read: () => Promise<T>, ms: number, deps: readonly unknown[] = []): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const run = useRef(0);
  const told = useRef(false);

  const reload = useCallback(async () => {
    const mine = run.current;
    try {
      const next = await readRef.current();
      if (mine === run.current) setData(next);
    } catch (err) {
      if (mine !== run.current || told.current) return;
      told.current = true;
      handleFetchError(err);
    }
  }, []);

  useEffect(() => {
    run.current++;
    told.current = false;
    void reload();
    const tick = () => { if (document.visibilityState === 'visible') void reload(); };
    const timer = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, reload, ...deps]);

  return { data, reload, set: setData };
}

// ── Sidebar and tab counts ────────────────────────────────────────────────────
// One reader for the whole app: the sidebar badge and the page's tab bar show
// the same numbers. Chats arrive from the extensions, not from this app, so it
// polls; a write on the page calls fbChatChanged() for an immediate read.

const CHANGED = 'fbchat-changed';
const NONE: FbChatSummary = { unread: 0, pending_devices: 0 };
let summary = NONE;
let reading = false;
let stale = false;
let timer = 0;
const readers = new Set<() => void>();

function readSummary() {
  if (reading) { stale = true; return; }
  reading = true;
  fbChatApi.summary()
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
    timer = window.setInterval(readIfVisible, FB_CHAT_POLL_MS.summary);
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

/** Unread chats and waiting extensions. Managers only; the API refuses anyone else. */
export function useFbChatSummary(enabled: boolean): FbChatSummary {
  const s = useSyncExternalStore(enabled ? watchSummary : watchNothing, () => summary);
  return enabled ? s : NONE;
}

/** Call after a write that changes a count: a chat read, a device approved or denied. */
export const fbChatChanged = () => window.dispatchEvent(new Event(CHANGED));
