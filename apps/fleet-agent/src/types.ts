// The host API as the ERP serves it. Defined here rather than imported from
// the shared package: this image is built without node_modules and must not
// pull the workspace in.

export interface Desired {
  authoritative: boolean;
  count: number;
  image: string;
  version: string;
  vnc_ports: Record<string, number>;
  roll: { replace: string } | null;
}

export interface ReportContainer {
  worker_id: string;
  image: string;
  state: string;
  started_at: string | null;
}

export interface Report {
  version: string;
  containers: ReportContainer[];
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

export function parseDesired(body: unknown): Desired | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.authoritative !== 'boolean') return null;
  if (typeof b.count !== 'number' || !Number.isInteger(b.count) || b.count < 0) return null;
  if (typeof b.image !== 'string') return null;
  const ports: Record<string, number> = {};
  if (b.vnc_ports !== undefined && b.vnc_ports !== null) {
    if (typeof b.vnc_ports !== 'object') return null;
    for (const [id, port] of Object.entries(b.vnc_ports as Record<string, unknown>)) {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      ports[id] = port;
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
  };
}
