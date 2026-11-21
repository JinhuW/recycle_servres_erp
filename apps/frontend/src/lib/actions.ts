import { useSyncExternalStore } from 'react';
import {
  ACTION_STATUSES,
  type ActionColumnOrder, type ActionEvent, type ActionItem, type ActionLink, type ActionLinkTarget,
  type ActionLinkType, type ActionPriority, type ActionStatus,
} from '@recycle-erp/shared';
import { api } from './api';

export type {
  ActionColumnOrder, ActionEvent, ActionItem, ActionLink, ActionLinkTarget, ActionLinkType, ActionPriority, ActionStatus,
};

const BASE = '/api/actions';

export type ActionDraft = {
  title: string;
  description: string | null;
  priority: ActionPriority;
  dueDate: string | null;
  assigneeId: string | null;
  link: { type: ActionLinkType; id: string } | null;
};

export const actionsApi = {
  board: (assignee?: string) =>
    api.get<{ items: ActionItem[] }>(assignee && assignee !== 'all' ? `${BASE}?assignee=${encodeURIComponent(assignee)}` : BASE),
  archive: (cursor?: string | null) =>
    api.get<{ items: ActionItem[]; nextCursor: string | null }>(`${BASE}/archive${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  mine: (limit = 5) => api.get<{ count: number; items: ActionItem[] }>(`${BASE}/mine?limit=${limit}`),
  byRecord: (type: ActionLinkType, id: string) =>
    api.get<{ items: ActionItem[] }>(`${BASE}/by-record?type=${type}&id=${encodeURIComponent(id)}`),
  counts: (type: ActionLinkType) => api.get<{ counts: Record<string, number> }>(`${BASE}/counts?type=${type}`),
  targets: (type: ActionLinkType, q: string) =>
    api.get<{ items: ActionLinkTarget[] }>(`${BASE}/link-targets?type=${type}&q=${encodeURIComponent(q)}`),
  detail: (id: string) => api.get<{ item: ActionItem; events: ActionEvent[] }>(`${BASE}/${encodeURIComponent(id)}`),
  create: (d: ActionDraft & { status?: ActionStatus }) => api.post<{ item: ActionItem }>(BASE, d),
  update: (id: string, d: Partial<ActionDraft>) => api.patch<{ item: ActionItem }>(`${BASE}/${encodeURIComponent(id)}`, d),
  move: (id: string, status: ActionStatus, beforeId: string | null) =>
    api.post<{ ok: true; order: ActionColumnOrder }>(`${BASE}/${encodeURIComponent(id)}/move`, { status, beforeId }),
  note: (id: string, note: string) => api.post<{ ok: true }>(`${BASE}/${encodeURIComponent(id)}/notes`, { note }),
  remove: (id: string) => api.delete<{ ok: true }>(`${BASE}/${encodeURIComponent(id)}`),
};

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export const STATUS_KEY: Record<ActionStatus, string> = {
  todo: 'actStatus_todo', in_progress: 'actStatus_in_progress', blocked: 'actStatus_blocked', done: 'actStatus_done',
};
export const PRIORITY_KEY: Record<ActionPriority, string> = {
  low: 'actPriority_low', normal: 'actPriority_normal', high: 'actPriority_high',
};
export const LINK_TYPE_KEY: Record<ActionLinkType, string> = {
  po: 'actLink_po', so: 'actLink_so', as: 'actLink_as', client: 'actLink_client', ws: 'actLink_ws', lot: 'actLink_lot',
};

/** The record's page, for a link the viewer can open. */
export function linkPath(link: Pick<ActionLink, 'type' | 'id'>): string | null {
  if (!link.id) return null;
  const id = encodeURIComponent(link.id);
  switch (link.type) {
    case 'po': return `/purchase-orders/${id}`;
    case 'so': return `/sell-orders/${id}`;
    case 'as': return `/after-sales/${id}`;
    case 'client': return `/clients/${id}`;
    case 'ws': return `/leads/website/${id}`;
    case 'lot': return `/inventory/${id}`;
  }
}

// ─── Board state ──────────────────────────────────────────────────────────────

export type Columns = Record<ActionStatus, ActionItem[]>;

/** The board's four columns, each top to bottom. */
export function toColumns(items: readonly ActionItem[]): Columns {
  const cols = Object.fromEntries(ACTION_STATUSES.map(s => [s, [] as ActionItem[]])) as Columns;
  for (const i of items) cols[i.status].push(i);
  for (const s of ACTION_STATUSES) cols[s].sort((a, b) => a.position - b.position);
  return cols;
}

const flat = (cols: Columns): ActionItem[] => ACTION_STATUSES.flatMap(s => cols[s]);

/**
 * The board as it looks right after a drop, before the server answers: the
 * card leaves its column and lands above `beforeId` in `to` (the bottom when
 * null or not there). Positions are rewritten 0..n-1 in each column touched.
 */
export function moveCard(items: readonly ActionItem[], id: string, to: ActionStatus, beforeId: string | null): ActionItem[] {
  const card = items.find(i => i.id === id);
  if (!card) return [...items];
  const cols = toColumns(items.filter(i => i.id !== id));
  const target = cols[to];
  const at = beforeId === null ? -1 : target.findIndex(i => i.id === beforeId);
  const moved: ActionItem = {
    ...card, status: to,
    completedAt: to !== 'done' ? null : card.status === 'done' ? card.completedAt : new Date().toISOString(),
  };
  if (at < 0) target.push(moved); else target.splice(at, 0, moved);
  for (const s of new Set<ActionStatus>([card.status, to])) {
    cols[s] = cols[s].map((i, n) => (i.position === n ? i : { ...i, position: n }));
  }
  return flat(cols);
}

/** Applies the order the server answered a move with. Cards it names keep their data. */
export function applyOrder(items: readonly ActionItem[], order: ActionColumnOrder): ActionItem[] {
  const placed = new Map<string, { status: ActionStatus; position: number }>();
  for (const s of ACTION_STATUSES) order[s]?.forEach((id, n) => placed.set(id, { status: s, position: n }));
  return items.map(i => {
    const p = placed.get(i.id);
    return p && (p.status !== i.status || p.position !== i.position) ? { ...i, ...p } : i;
  });
}

/** Where a drop lands in a column: above the first card whose middle is below `y`. */
export function slotFromRects(cards: readonly { id: string; top: number; bottom: number }[], y: number): string | null {
  for (const c of cards) if (y < (c.top + c.bottom) / 2) return c.id;
  return null;
}

/**
 * Whether a poll answer may replace the board. A read that started before the
 * last local change, or lands mid-drag, would put back what the user just did.
 */
export function pollIsFresh(startedAt: number, lastChangeAt: number, dragging: boolean): boolean {
  return !dragging && startedAt > lastChangeAt;
}

// ─── My open cards (sidebar count, Home) ──────────────────────────────────────

const ACTIONS_CHANGED = 'act-actions-changed';
let mineCount = 0;
let reading = false;
let stale = false;
const readers = new Set<() => void>();

export function refreshActionsCount() {
  if (reading) { stale = true; return; }
  reading = true;
  actionsApi.mine(1)
    // A count that fails to load stays as it was; it is never worth a dialog.
    .then(r => { mineCount = r.count; for (const l of readers) l(); }, () => {})
    .finally(() => {
      reading = false;
      if (stale) { stale = false; refreshActionsCount(); }
    });
}

const onVisible = () => { if (document.visibilityState === 'visible') refreshActionsCount(); };

function watchCount(onChange: () => void) {
  if (readers.size === 0) {
    window.addEventListener(ACTIONS_CHANGED, refreshActionsCount);
    document.addEventListener('visibilitychange', onVisible);
  }
  readers.add(onChange);
  if (!reading) refreshActionsCount();
  return () => {
    readers.delete(onChange);
    if (readers.size === 0) {
      window.removeEventListener(ACTIONS_CHANGED, refreshActionsCount);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export function useMyActionsCount(): number {
  return useSyncExternalStore(watchCount, () => mineCount);
}

export const actionsChanged = () => window.dispatchEvent(new Event(ACTIONS_CHANGED));
