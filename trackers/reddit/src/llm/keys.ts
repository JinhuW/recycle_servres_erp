// Provider API keys. The ERP pushes them into `llm_keys` over the admin API;
// env keys fill any provider without a row, so a fleet configured by env
// alone keeps working.

import type {Sql} from '../db.ts';
import type {LlmKeys} from './index.ts';
import type {Provider} from './ref.ts';

export const PROVIDERS: readonly Provider[] = ['openrouter', 'anthropic', 'openai'];

export const MAX_KEY_LENGTH = 500;

/** The env var that holds each provider's fallback key. */
export const KEY_ENV: Record<Provider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// Whitespace or a control character inside a key is a paste accident, and
// sent as a header it makes fetch throw an error that quotes the value.
const KEY_FORBIDDEN = /[\s\x00-\x1f\x7f]/;

const CACHE_TTL_MS = 60_000;

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Why a pasted key can't be stored, or null when it can. */
export function invalidKeyReason(key: string): string | null {
  if (!key || key.length > MAX_KEY_LENGTH) {
    return `key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`;
  }
  if (KEY_FORBIDDEN.test(key)) {
    return 'key must not contain spaces, line breaks or control characters';
  }
  return null;
}

/** What GET /api/llm-keys shows: enough to recognise a key, never the key. */
export interface KeySummary {
  provider: Provider;
  /** A stored key exists; env keys don't count, since the ERP manages only these. */
  configured: boolean;
  /** Last 4 characters of the stored key. */
  last4: string | null;
  /** The tracker can call this provider, with a stored or an env key. */
  available: boolean;
  /** Which key calls use: a stored key wins over env. */
  source: 'stored' | 'env' | null;
}

/** The part of KeyStore the evaluate loop needs. */
export interface KeySource {
  get(): Promise<LlmKeys>;
}

export class KeyStore implements KeySource {
  private cache: LlmKeys | null = null;
  private cachedAt = 0;

  constructor(
    private readonly sql: Sql,
    private readonly envKeys: LlmKeys = {},
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Stored keys over env keys, re-read at most once per TTL, which is how a
   * key the ERP pushes reaches every worker without a restart.
   */
  async get(): Promise<LlmKeys> {
    if (this.cache && this.now() - this.cachedAt < this.ttlMs) return this.cache;

    const merged: LlmKeys = {};
    for (const provider of PROVIDERS) {
      const env = this.envKeys[provider];
      if (env) merged[provider] = env;
    }
    for (const row of await this.rows()) merged[row.provider] = row.api_key;

    this.cache = merged;
    this.cachedAt = this.now();
    return merged;
  }

  async set(provider: Provider, apiKey: string): Promise<void> {
    await this.sql`
      INSERT INTO llm_keys (provider, api_key, updated_at)
      VALUES (${provider}, ${apiKey}, NOW())
      ON CONFLICT (provider) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = NOW()`;
    this.invalidate();
  }

  async remove(provider: Provider): Promise<void> {
    await this.sql`DELETE FROM llm_keys WHERE provider = ${provider}`;
    this.invalidate();
  }

  /**
   * `configured` and `last4` describe stored keys only, which the ERP
   * manages; `available` and `source` also count the env fallbacks, so the
   * ERP can offer only providers the tracker can call.
   */
  async summary(): Promise<KeySummary[]> {
    const stored = new Map((await this.rows()).map((r) => [r.provider, r.api_key]));
    return PROVIDERS.map((provider) => {
      const key = stored.get(provider);
      const source = key !== undefined ? 'stored' : this.envKeys[provider] ? 'env' : null;
      return {
        provider,
        configured: key !== undefined,
        last4: key === undefined ? null : key.slice(-4),
        available: source !== null,
        source,
      };
    });
  }

  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }

  private rows(): Promise<Array<{provider: Provider; api_key: string}>> {
    return this.sql<Array<{provider: Provider; api_key: string}>>`
      SELECT provider, api_key FROM llm_keys`;
  }
}
