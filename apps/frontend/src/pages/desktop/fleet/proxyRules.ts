import {
  isFleetTimezone, parseProxyUrl, proxyLoad, type FleetDeviceProfile, type FleetProxy, type FleetSlot,
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

export type ProxyChoice = { proxy: FleetProxy; load: number; full: boolean };

/** Every proxy with how many accounts it carries, the emptiest first; a full one stays listed, disabled. */
export function proxyChoices(proxies: readonly FleetProxy[], limit: number): ProxyChoice[] {
  return proxies
    .map((proxy) => {
      const load = proxyLoad(proxy);
      return { proxy, load, full: load >= limit };
    })
    .sort((a, b) => Number(a.full) - Number(b.full) || a.load - b.load || a.proxy.label.localeCompare(b.proxy.label));
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
