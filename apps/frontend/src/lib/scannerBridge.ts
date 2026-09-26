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

/** Error carrying the bridge's own message ("Printer unreachable …"). */
export class BridgeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Scans one flatbed page through the bridge. A 300 dpi page takes ~10 s. */
export async function bridgeScan(timeoutMs = 120_000): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}/scan`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new BridgeError(0, '');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new BridgeError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return res.blob();
}
