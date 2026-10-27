// ─── Read cache for the fleet console's GET answers ──────────────────────────
// The console rebuilds its fleet view from scratch on every call (seconds of
// remote-database work), and every manager with the Fleet page open polls it.
// Holding the last good answer here bounds the console's load by this process,
// not by the number of viewers. One cache per backend process: a second
// instance would only double the upstream rate, never serve wrong data.

export type CacheState = 'hit' | 'stale' | 'miss';

export interface Answer {
  status: number;
  /** undefined for a status that carries no body. */
  payload: unknown;
}

export interface CachedAnswer extends Answer {
  cache: CacheState;
  /** Whole seconds since the answer was fetched upstream. */
  ageS: number;
}

interface Entry {
  answer: Answer;
  storedAt: number;
}

export interface AnswerCacheOptions {
  freshMs: number;
  staleMs: number;
  now?: () => number;
  /** Told when a refresh comes back without a 2xx; readers keep the old copy. */
  onRefreshFailed?: (key: string, status: number) => void;
}

const ok = (status: number): boolean => status >= 200 && status < 300;
// A 4xx is the upstream's verdict on this request and goes out as it is; only
// the upstream being down or refusing us falls back on the last good copy.
const upstreamFailed = (status: number): boolean => status >= 500;

export class AnswerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Answer>>();
  // A write clears the cache while a read started before it may still be in
  // flight; that read's answer predates the write and must not be stored.
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly opts: AnswerCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  async get(key: string, load: () => Promise<Answer>): Promise<CachedAnswer> {
    const entry = this.entries.get(key);
    const age = entry ? this.now() - entry.storedAt : Infinity;
    if (entry && age < this.opts.freshMs) return this.served(entry, 'hit');
    if (entry && age < this.opts.staleMs) {
      if (!this.inflight.has(key)) void this.refresh(key, load).catch(() => undefined);
      return this.served(entry, 'stale');
    }
    const answer = await (this.inflight.get(key) ?? this.refresh(key, load));
    const fallback = this.entries.get(key);
    if (!ok(answer.status) && fallback && upstreamFailed(answer.status)) {
      return this.served(fallback, 'stale');
    }
    return { ...answer, cache: 'miss', ageS: 0 };
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
  }

  /** Makes every entry `ms` older, so a test can step past a window. */
  _backdateForTests(ms: number): void {
    for (const entry of this.entries.values()) entry.storedAt -= ms;
  }

  private served(entry: Entry, cache: CacheState): CachedAnswer {
    const ageS = Math.max(0, Math.floor((this.now() - entry.storedAt) / 1000));
    return { ...entry.answer, cache, ageS };
  }

  private refresh(key: string, load: () => Promise<Answer>): Promise<Answer> {
    const generation = this.generation;
    const run: Promise<Answer> = load()
      .then((answer) => {
        if (generation === this.generation) {
          if (ok(answer.status)) this.entries.set(key, { answer, storedAt: this.now() });
          else this.opts.onRefreshFailed?.(key, answer.status);
        }
        return answer;
      })
      .finally(() => {
        if (this.inflight.get(key) === run) this.inflight.delete(key);
      });
    this.inflight.set(key, run);
    return run;
  }
}
