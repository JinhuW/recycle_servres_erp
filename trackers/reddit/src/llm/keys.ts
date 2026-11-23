// Provider API keys. The ERP pushes them into `llm_keys` over the admin API;
// env keys fill any provider without a row, so a fleet configured by env
// alone keeps working.

import type {Sql} from '../db.ts';
import type {LlmKeys} from './index.ts';
import type {Provider} from './ref.ts';

export const PROVIDERS: readonly Provider[] = ['openrouter', 'anthropic', 'openai'];

export const MAX_KEY_LENGTH = 500;

const CACHE_TTL_MS = 60_000;

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** What GET /api/llm-keys shows: enough to recognise a key, never the key. */
export interface KeySummary {
  provider: Provider;
  configured: boolean;
  last4: string | null;
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

  /** Stored keys only: the ERP manages these, not the env fallbacks. */
  async summary(): Promise<KeySummary[]> {
    const stored = new Map((await this.rows()).map((r) => [r.provider, r.api_key]));
    return PROVIDERS.map((provider) => {
      const key = stored.get(provider);
      return {
        provider,
        configured: key !== undefined,
        last4: key === undefined ? null : key.slice(-4),
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
