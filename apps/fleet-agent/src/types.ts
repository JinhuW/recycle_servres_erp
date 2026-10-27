// The host API as the ERP serves it. Defined here rather than imported from
// the shared package: this image is built without node_modules and must not
// pull the workspace in.

export interface Desired {
  authoritative: boolean;
  count: number;
  image: string;
  version: string;
  vnc_ports: Record<string, number>;
  leases?: Record<string, { account_no: number; epoch: number }>;
  roll: { replace: string } | null;
}

/** Why a stopped worker is left stopped; the ERP must not wait on it. */
export type Hold = 'operator_needed' | 'crash_limit' | 'operator_stopped';

export interface ReportContainer {
  worker_id: string;
  image: string;
  /** Docker's state, or the hold's name for a worker left stopped on purpose. */
  state: string;
  started_at: string | null;
  hold?: Hold;
  exit_code?: number | null;
  /** The local image id (`sha256:…`) the container runs: tells a re-pushed tag apart. */
  image_id?: string;
}

export interface AgentIdentity {
  instance_id: string;
  daemon_id: string | null;
}

export interface Report {
  version: string;
  containers: ReportContainer[];
  agent?: AgentIdentity & { conflict?: string[] };
}

/** The reading of "nothing usable": starts nothing, stops nothing. */
export const EMPTY_DESIRED: Desired = {
  authoritative: false,
  count: 0,
  image: '',
  version: '',
  vnc_ports: {},
  roll: null,
};

// Capacity is 0..99 in the ERP; anything far past it is not a desired state.
export const MAX_COUNT = 999;

export function parseDesired(body: unknown): Desired | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.authoritative !== 'boolean') return null;
  if (typeof b.count !== 'number' || !Number.isInteger(b.count) || b.count < 0 || b.count > MAX_COUNT) return null;
  if (typeof b.image !== 'string') return null;
  const ports: Record<string, number> = {};
  if (b.vnc_ports !== undefined && b.vnc_ports !== null) {
    if (typeof b.vnc_ports !== 'object') return null;
    for (const [id, port] of Object.entries(b.vnc_ports as Record<string, unknown>)) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      ports[id] = port;
    }
  }
  // One odd lease entry drops that entry, not the whole answer: a rejected
  // answer reads as "offline" and would stop the reports.
  const leases: NonNullable<Desired['leases']> = {};
  const leasesGiven = b.leases !== undefined && b.leases !== null && typeof b.leases === 'object' && !Array.isArray(b.leases);
  if (leasesGiven) {
    for (const [id, raw] of Object.entries(b.leases as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (!Number.isInteger(entry.account_no) || !Number.isInteger(entry.epoch)
          || (entry.account_no as number) < 1 || (entry.epoch as number) < 0) continue;
      leases[id] = { account_no: entry.account_no as number, epoch: entry.epoch as number };
    }
  }
  let roll: Desired['roll'] = null;
  if (b.roll !== undefined && b.roll !== null) {
    const r = b.roll as Record<string, unknown>;
    if (typeof r !== 'object' || typeof r.replace !== 'string' || !r.replace) return null;
    roll = { replace: r.replace };
  }
  return {
    authoritative: b.authoritative,
    count: b.count,
    image: b.image,
    version: typeof b.version === 'string' ? b.version : '',
    vnc_ports: ports,
    roll,
    ...(leasesGiven ? { leases } : {}),
  };
}

// The ERP's own check on a release's image, repeated here: the agent is the
// last place before `docker run`.
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]{1,128})?(@sha256:[0-9a-f]{64})?$/;

export const DEFAULT_IMAGE_PREFIX = 'ghcr.io/jinhuw/aimm-recycle';

/** Whether `image` is a well-formed reference under one of `prefixes` (repository match, any tag or digest). */
export function imageAllowed(image: string, prefixes: readonly string[] | undefined): boolean {
  if (!IMAGE_REF.test(image)) return false;
  if (!prefixes) return true;
  return prefixes.some((p) => image === p || image.startsWith(`${p}:`) || image.startsWith(`${p}@`));
}

export function isDigestRef(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image);
}
