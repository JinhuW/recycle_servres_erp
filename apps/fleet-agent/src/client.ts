// The agent's calls to the ERP: the desired state in, a claim ticket for each
// worker it runs, stop confirmations and a report back.
//
// None of them throws. `desired` answers null for "offline" (the agent falls
// back to what it cached; an ERP outage must never reach the workers) and
// 'refused' when the ERP answered that this host may not ask (401/403/404:
// a deleted host or a revoked token), which the agent reads as observe-only
// rather than as a reason to keep acting on its cache. One attempt each with
// a short timeout: the loop comes round again in seconds.

import type { StopIdentity } from './state.js';
import { parseDesired, type AgentIdentity, type Desired, type Report } from './types.js';

export type DesiredAnswer = Desired | null | 'refused';

export interface FleetClient {
  desired(): Promise<DesiredAnswer>;
  stopped?(workerId: string, identity: StopIdentity): Promise<boolean | 'stale'>;
  /** A single-use claim ticket for the container about to run; null when the ERP gave none. */
  ticket(workerId: string, handoffEpoch?: number): Promise<string | null>;
  report(payload: Report): Promise<boolean>;
  /** Names this agent on every later call. */
  identify?(identity: AgentIdentity): void;
}

export interface HttpClientOptions {
  baseUrl: string;
  hostId: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onFailure?: (what: string, detail: string) => void;
}

const REFUSED = new Set([401, 403, 404]);

type Answer = { ok: true; body: unknown } | { ok: false; status: number | null };

export class HttpFleetClient implements FleetClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onFailure: (what: string, detail: string) => void;
  private identity: AgentIdentity | null = null;

  constructor(private readonly opts: HttpClientOptions) {
    this.base = opts.baseUrl.trim().replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onFailure = opts.onFailure ?? (() => {});
  }

  identify(identity: AgentIdentity): void {
    this.identity = identity;
  }

  private url(part: string): string {
    return `${this.base}/api/fleet/hosts/${encodeURIComponent(this.opts.hostId)}/${part}`;
  }

  async desired(): Promise<DesiredAnswer> {
    const answer = await this.request('GET', 'desired');
    if (!answer.ok) return answer.status !== null && REFUSED.has(answer.status) ? 'refused' : null;
    const desired = parseDesired(answer.body);
    if (!desired) this.onFailure('desired', 'answer is not a desired state');
    return desired;
  }

  async stopped(workerId: string, identity: StopIdentity): Promise<boolean | 'stale'> {
    const answer = await this.request('POST', 'stopped', {
      worker_id: workerId, account_no: identity.account_no, epoch: identity.epoch, restart: identity.restart,
      ...(this.identity ? { agent_instance: this.identity.instance_id, daemon_id: this.identity.daemon_id } : {}),
    });
    if (!answer.ok) return answer.status === 409 ? 'stale' : false;
    return true;
  }

  async ticket(workerId: string, handoffEpoch?: number): Promise<string | null> {
    const answer = await this.request('POST', 'tickets', {
      worker_id: workerId, ...(handoffEpoch !== undefined ? { handoff_epoch: handoffEpoch } : {}),
    });
    if (!answer.ok) return null;
    const t = (answer.body as { ticket?: unknown } | null)?.ticket;
    if (typeof t === 'string' && /^fct_[A-Za-z0-9_-]{16,128}$/.test(t)) return t;
    this.onFailure('tickets', 'answer carries no ticket');
    return null;
  }

  async report(payload: Report): Promise<boolean> {
    return (await this.request('POST', 'report', payload)).ok;
  }

  private async request(method: string, part: string, payload?: unknown): Promise<Answer> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, Accept: 'application/json' };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (this.identity) {
      headers['X-Fleet-Agent-Instance'] = this.identity.instance_id;
      if (this.identity.daemon_id) headers['X-Fleet-Docker-Daemon'] = this.identity.daemon_id;
    }
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
      return { ok: false, status: null };
    }
    if (!res.ok) {
      if (!(part === 'stopped' && res.status === 409)) this.onFailure(part, `HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status };
    }
    const text = await res.text().catch(() => '');
    if (!text.trim()) return { ok: true, body: {} };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      this.onFailure(part, 'answer is not JSON');
      return { ok: false, status: null };
    }
  }
}
