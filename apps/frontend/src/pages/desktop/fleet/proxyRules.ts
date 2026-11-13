import {
  FLEET_EXIT_FRESH_MS, isFleetTimezone, parseProxyUrl, proxyLoad, type FleetDeviceProfile, type FleetProxy, type FleetProxyExitChange, type FleetProxyHealth, type FleetProxyHealthState, type FleetSlot,
} from '../../../lib/fleet';
import { leaseLive } from './fleetBoard';

// ─── Proxies and Add to fleet: the pure part ──────────────────────────────────
// What the Account pool tab's fleet actions and the Proxies card decide
// before anything is sent: which action an account row offers, which proxies
// a new slot may go on, whether a proxy form is complete. The backend checks
// all of it again; these only keep a manager from asking for a refusal.

/** The ERP's pool holder for an account put in the fleet and not yet claimed (fleet/workers.ts). */
export const FLEET_HOLDER = 'ERP fleet';

export type FleetRowAction =
  | { kind: 'add' }
  /** Available, but nothing to sign in with yet. */
  | { kind: 'add-blocked' }
  | { kind: 'remove'; slot: FleetSlot }
  /** A worker (or a reservation for one) holds it: park first. */
  | { kind: 'remove-blocked'; slot: FleetSlot };

type PoolRow = { status: string; holder: string | null; password: string; totp: string };

/** The fleet action an account row offers, or null for none. */
export function fleetRowAction(a: PoolRow, slot: FleetSlot | undefined, now: number = Date.now()): FleetRowAction | null {
  if (slot) return leaseLive(slot, now) ? { kind: 'remove-blocked', slot } : { kind: 'remove', slot };
  // A fleet account with no slot is a coordinator worker's, unless it carries
  // the ERP's own label (a slot removed by hand, say).
  const ours = a.status === 'fleet' && (a.holder === null || a.holder.toLowerCase() === FLEET_HOLDER.toLowerCase());
  if (a.status !== 'available' && !ours) return null;
  return a.password && a.totp ? { kind: 'add' } : { kind: 'add-blocked' };
}

export type ProxyChoice = { proxy: FleetProxy; load: number; full: boolean; state: FleetProxyHealthState; down: boolean; exhausted: boolean };

/**
 * Every proxy with how many accounts it carries and how its last checks went:
 * the open ones first, emptiest first, then the down or exhausted ones, then the full ones.
 * A proxy missing from `health` (or with no health read at all) is unchecked.
 * `moving` is the account a move is for: as the server does, it is left out of
 * the count on the IP it leaves.
 */
export function proxyChoices(
  proxies: readonly FleetProxy[], limit: number, health: ReadonlyMap<number, FleetProxyHealthState> = new Map(),
  moving: number | null = null,
): ProxyChoice[] {
  const rank = (c: ProxyChoice) => (c.full ? 2 : c.down || c.exhausted ? 1 : 0);
  const from = moving === null ? undefined
    : proxies.find((p) => p.slots.some((s) => s.account_no === moving && !s.parked));
  const sameExit = (p: FleetProxy) => from !== undefined && (from.exit_ip === null ? p.id === from.id : p.exit_ip === from.exit_ip);
  return proxies
    .map((proxy) => {
      // The limit is per exit IP, and other ports can exit from this one's.
      const load = proxy.exit_load - (sameExit(proxy) ? 1 : 0);
      const state = health.get(proxy.id) ?? 'unchecked';
      return { proxy, load, full: load >= limit, state, down: state === 'down', exhausted: proxy.exhausted };
    })
    .sort((a, b) => rank(a) - rank(b) || a.load - b.load || a.proxy.label.localeCompare(b.proxy.label));
}

// Fixed, unlike max_accounts_per_proxy: they say an exit IP looks crowded
// whatever the limit is set to, and homelab ports have no limit at all.
export const PROXY_CROWD_WARN_AT = 5;
export const PROXY_CROWD_OVER_ABOVE = 10;

/** How crowded an exit IP is with `n` accounts on it: null, yellow from 5, red above 10. */
export function proxyCrowding(n: number): 'warn' | 'over' | null {
  if (n > PROXY_CROWD_OVER_ABOVE) return 'over';
  return n >= PROXY_CROWD_WARN_AT ? 'warn' : null;
}

export type ProxyExitFlag =
  /** The last measurement is too old to trust, or there has never been one (`at` null). */
  | { kind: 'stale'; at: string | null }
  /** The last check found no exit. */
  | { kind: 'failing' }
  /** Pilot accounts whose first login waits: the port moved off the exit they enrolled on. */
  | { kind: 'held'; slots: { account_no: number; exit_ip: string }[] }
  /** Accounts whose device keeps another clock than the exit's zone. */
  | { kind: 'zone'; zone: string; slots: { account_no: number; timezone: string }[] }
  | { kind: 'changed'; change: FleetProxyExitChange };

/**
 * What to tell a manager about a port's measured exit. Report only: nothing
 * here changes a device or refuses an account. An old failure reads as stale,
 * since that is the more urgent fact: nobody is measuring. Zones compare by
 * name, so America/Detroit against America/New_York flags too: a browser shows
 * the name, and the hover gives both for a manager to judge.
 */
export function proxyExitFlags(p: Pick<FleetProxyHealth, 'last' | 'slots' | 'exit_change'>, now: number = Date.now()): ProxyExitFlag[] {
  const out: ProxyExitFlag[] = [];
  const { last } = p;
  if (!last || now - Date.parse(last.at) > FLEET_EXIT_FRESH_MS) out.push({ kind: 'stale', at: last?.at ?? null });
  else if (!last.ok || !last.exit_ip) out.push({ kind: 'failing' });
  const held = p.slots.flatMap((s) => (s.held_exit_ip ? [{ account_no: s.account_no, exit_ip: s.held_exit_ip }] : []));
  if (held.length) out.push({ kind: 'held', slots: held });
  const zone = last?.timezone;
  if (zone) {
    const slots = p.slots.flatMap((s) => (s.timezone && s.timezone !== zone ? [{ account_no: s.account_no, timezone: s.timezone }] : []));
    if (slots.length) out.push({ kind: 'zone', zone, slots });
  }
  if (p.exit_change) out.push({ kind: 'changed', change: p.exit_change });
  return out;
}

/** True when a new slot may go on the choice: room left, not failing its checks, IP not exhausted. */
export const proxyOpen = (c: ProxyChoice): boolean => !c.full && !c.down && !c.exhausted;

/** The dialog's default when the manager does not pick one: an open proxy, a healthy one while any is. */
export function randomOpenProxy(choices: readonly ProxyChoice[], rand: () => number = Math.random): FleetProxy | null {
  const open = choices.filter(proxyOpen);
  const up = open.filter((c) => c.state === 'up');
  const from = up.length ? up : open;
  return from.length ? from[Math.floor(rand() * from.length)]!.proxy : null;
}

/**
 * What a live check says about moving an account onto a proxy: a miss or a
 * down verdict stops it, anything short of a clean answer warns (`check` null
 * is a check that could not run).
 */
export function proxyChangeVerdict(check: Pick<FleetProxyHealth, 'state' | 'last'> | null): 'ok' | 'warn' | 'blocked' {
  if (!check) return 'warn';
  if (check.state === 'down' || check.last?.ok === false) return 'blocked';
  return check.state === 'up' ? 'ok' : 'warn';
}

export const proxyExit = (p: Pick<FleetProxy, 'host' | 'port'>): string => `${p.host}:${p.port}`;

export type ProxyDraft = { label: string; url: string; timezone: string; note: string };

/**
 * The i18n key of what is wrong with a proxy form, or null. Editing, an empty
 * URL keeps the saved one: the field is write-only and starts empty.
 */
export function proxyDraftProblem(d: ProxyDraft, editing: boolean): string | null {
  if (!d.label.trim()) return 'fleetProxyNeedLabel';
  if (d.url.trim() || !editing) {
    if ('error' in parseProxyUrl(d.url)) return 'fleetProxyBadUrl';
  }
  if (!isFleetTimezone(d.timezone.trim())) return 'fleetProxyBadTimezone';
  return null;
}

/** What a proxy form sends: an edit leaves out the URL when the field is empty, and anything unchanged. */
export function proxyPatch(d: ProxyDraft, saved: FleetProxy | null): Record<string, string> {
  const out: Record<string, string> = {};
  const label = d.label.trim();
  const timezone = d.timezone.trim();
  const note = d.note.trim();
  if (!saved || label !== saved.label) out.label = label;
  if (!saved || timezone !== saved.timezone) out.timezone = timezone;
  if (!saved ? note !== '' : note !== saved.note) out.note = note;
  if (d.url.trim()) out.url = d.url.trim();
  return out;
}

/** A device as the dialog describes it: `1536×864`, its scale and its clock. */
export function deviceSummary(d: FleetDeviceProfile): { screen: string; scale: number; timezone: string } {
  const [w, h] = d.screen ?? d.viewport;
  return { screen: `${w}×${h}`, scale: d.device_scale_factor ?? 1, timezone: d.timezone };
}
