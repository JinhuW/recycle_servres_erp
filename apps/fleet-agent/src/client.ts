// The agent's two calls to the ERP: the desired state in, a report back.
//
// Both answer null (or false) on any failure and never throw. The agent reads
// null as "offline" and falls back to what it cached; an ERP outage must never
// reach the workers. One attempt each with a short timeout: the loop comes
// round again in seconds.

import { parseDesired, type Desired, type Report } from './types.js';

export interface FleetClient {
  desired(): Promise<Desired | null>;
  report(payload: Report): Promise<boolean>;
}

export interface HttpClientOptions {
  baseUrl: string;
  hostId: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onFailure?: (what: string, detail: string) => void;
}

export class HttpFleetClient implements FleetClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onFailure: (what: string, detail: string) => void;

  constructor(private readonly opts: HttpClientOptions) {
    this.base = opts.baseUrl.trim().replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onFailure = opts.onFailure ?? (() => {});
  }

  private url(part: string): string {
    return `${this.base}/api/fleet/hosts/${encodeURIComponent(this.opts.hostId)}/${part}`;
  }

  async desired(): Promise<Desired | null> {
    const body = await this.request('GET', 'desired');
    if (body === null) return null;
    const desired = parseDesired(body);
    if (!desired) this.onFailure('desired', 'answer is not a desired state');
    return desired;
  }

  async report(payload: Report): Promise<boolean> {
    return (await this.request('POST', 'report', payload)) !== null;
  }

  private async request(method: string, part: string, payload?: unknown): Promise<unknown | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, Accept: 'application/json' };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(part), {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      this.onFailure(part, e instanceof Error ? e.message : String(e));
      return null;
    }
    if (!res.ok) {
      this.onFailure(part, `HTTP ${res.status}`);
      return null;
    }
    const text = await res.text().catch(() => '');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      this.onFailure(part, 'answer is not JSON');
      return null;
    }
  }
}
