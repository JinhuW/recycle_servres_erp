import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';

// What a picker needs of a member.
export type MemberOption = {
  id: string;
  name: string;
};

// A row of GET /api/members/names: every role may read it, and it is one
// scan of users. `active` is optional for deploy skew.
export type MemberName = MemberOption & { role?: string; active?: boolean };

// One read of each list per minute, for the whole page: a PO page, its
// hand-off dialog and an entry drawer all mount pickers at once, and the
// names barely move while a page is open. /api/members is never the source
// here — it computes every member's lifetime profit.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; items: Promise<MemberName[]> }>();

function loadNames(includeInactive: boolean): Promise<MemberName[]> {
  const url = '/api/members/names' + (includeInactive ? '?includeInactive=true' : '');
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
  const items = api.get<{ items: MemberName[] }>(url).then(r => r.items);
  // A failed read is not kept: the next picker asks again.
  items.catch(() => { if (cache.get(url)?.items === items) cache.delete(url); });
  cache.set(url, { at: Date.now(), items });
  return items;
}

/** Drops the cached lists, after a write that changes who the members are. */
export function forgetMembers(): void {
  cache.clear();
}

function useNames(includeInactive: boolean): MemberName[] {
  const [items, setItems] = useState<MemberName[]>([]);
  useEffect(() => {
    let alive = true;
    loadNames(includeInactive).then(r => { if (alive) setItems(r); }, handleFetchError);
    return () => { alive = false; };
  }, [includeInactive]);
  return items;
}

/** The active members with their roles, for any role's pickers: a
 *  collector, a Paid by. */
export function useMembers(): MemberName[] {
  return useNames(false);
}

// The managers, for the pickers that may only name one: a sell order's
// receiver, an after-sales assignee. The backend refuses anyone else.
export function useManagerOptions(): MemberOption[] {
  const members = useMembers();
  return useMemo(
    () => members.filter(m => m.role === 'manager').map(m => ({ id: m.id, name: m.name })), [members]);
}

// Everyone who has been a member, deactivated ones included, for reading back
// a name a record already holds: a payer may be a purchaser, or a manager who
// has since left. A manager's read; anyone else gets the active members.
export function useMemberNames(): MemberOption[] {
  const members = useNames(true);
  return useMemo(() => members.map(m => ({ id: m.id, name: m.name })), [members]);
}
