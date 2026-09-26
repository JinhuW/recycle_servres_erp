// Client for the local scanner bridge (repo `auto_ram_scanner`, RS-109): a
// loopback process on the purchaser's Mac that drives the office flatbed
// over eSCL. The ERP backend is in the cloud and can't reach the LAN
// printer, and a page can't call the printer directly (mixed content, CORS),
// but it can call loopback. Deliberately plain fetch, not lib/api.ts: this is
// not our backend — no cookies, no CSRF header, no refresh.

export const BRIDGE_URL = 'http://127.0.0.1:47811';

export type BridgeHealth = {
  ok: boolean;
  version: string;
  scanner: { url: string; state?: string; error?: string };
};

/** The bridge's health, or null when it isn't running (or Chrome blocked it). */
export async function bridgeHealth(timeoutMs = 1500): Promise<BridgeHealth | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as BridgeHealth) : null;
  } catch {
    return null;
  }
}

/**
 * Why a bridge scan failed, as the dialog needs to tell it apart:
 * - `down`: the bridge isn't reachable (not running, or Chrome blocked it)
 * - `busy`: the printer or bridge is already scanning
 * - `printer`: the bridge is up but the printer failed (asleep, off network, timeout)
 * - `cancelled`: the page aborted the scan itself
 */
export type BridgeErrorKind = 'down' | 'busy' | 'printer' | 'cancelled';

/** Error carrying the bridge's own message ("Printer unreachable …"). */
export class BridgeError extends Error {
  constructor(public kind: BridgeErrorKind, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * Scans one flatbed page through the bridge. A 300 dpi page takes ~10 s.
 * Aborting `signal` cancels it: the bridge sees the request go away and
 * deletes the printer's job.
 */
export async function bridgeScan(signal?: AbortSignal, timeoutMs = 120_000): Promise<Blob> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}/scan`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    if (signal?.aborted) throw new BridgeError('cancelled', '');
    if (timeout.aborted) throw new BridgeError('printer', 'The scan took too long.');
    throw new BridgeError('down', '');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; kind?: string } | null;
    // The bridge names the kind; status is only the fallback for an old bridge.
    const kind: BridgeErrorKind =
      body?.kind === 'busy' || (!body?.kind && res.status === 409) ? 'busy'
      : body?.kind === 'cancelled' ? 'cancelled'
      : 'printer';
    throw new BridgeError(kind, body?.error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}
