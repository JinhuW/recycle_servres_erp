// Reddit rate limiting is enforced per source IP, and every VM has its own
// IP, so the limiter is purely in-process — no cross-worker coordination
// needed. Each worker keeps itself under its own budget and the fleet scales
// linearly with VM count.

export interface PacerOptions {
  /** Requests per minute this process may make. Reddit allows ~10 anonymous. */
  maxRpm: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; must return a value in [0, 1). */
  random?: () => number;
}

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const JITTER = 0.2;

export class RedditPacer {
  private readonly minGapMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private lastRequestAt = 0;
  private blockedUntil = 0;
  private consecutiveBlocks = 0;

  constructor(options: PacerOptions) {
    this.minGapMs = 60_000 / options.maxRpm;
    this.now = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /** Milliseconds until a request is allowed; 0 when one may go out now. */
  waitMs(): number {
    const now = this.now();
    return Math.max(0, this.blockedUntil - now, this.lastRequestAt + this.minGapMs - now);
  }

  /**
   * Blocks until a request may go out, then reserves the slot. Call this
   * BEFORE claiming subreddits so a worker never holds a claim it cannot yet
   * service — a held claim is invisible to the rest of the fleet.
   */
  async acquire(): Promise<void> {
    let wait = this.waitMs();
    while (wait > 0) {
      await this.sleepFn(wait);
      wait = this.waitMs();
    }
    this.lastRequestAt = this.now();
  }

  /** Clears the backoff after a request Reddit accepted. */
  recordSuccess(): void {
    this.consecutiveBlocks = 0;
    this.blockedUntil = 0;
  }

  /**
   * Applies Reddit's own rate-limit accounting. Its anonymous bucket is small
   * enough that one request can exhaust it, so when the server says nothing is
   * remaining we wait out its reset instead of trusting our configured rate.
   */
  recordRateLimit(hint: {remaining?: number; resetSeconds?: number}): void {
    if (hint.remaining === undefined || hint.remaining > 0) return;
    const resetMs = Math.min((hint.resetSeconds ?? 60) * 1000, MAX_BACKOFF_MS);
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + resetMs);
  }

  /**
   * Records a 429/403/block page and pauses this process' Reddit traffic.
   * Jitter keeps a fleet that got blocked simultaneously from retrying in
   * lockstep and re-triggering the block.
   */
  recordBlocked(retryAfterSeconds?: number): void {
    this.consecutiveBlocks++;
    const exponential = Math.min(
      BASE_BACKOFF_MS * 2 ** (this.consecutiveBlocks - 1),
      MAX_BACKOFF_MS,
    );
    const base = retryAfterSeconds !== undefined
      ? Math.max(retryAfterSeconds * 1000, exponential)
      : exponential;
    const jittered = base * (1 + (this.random() * 2 - 1) * JITTER);
    this.blockedUntil = this.now() + Math.min(jittered, MAX_BACKOFF_MS * (1 + JITTER));
  }

  /** Exposed for the health endpoint. */
  blockedUntilTimestamp(): number {
    return this.blockedUntil;
  }
}
