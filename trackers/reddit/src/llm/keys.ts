// Provider API keys. The ERP pushes them into `llm_keys` over the admin API,
// and calls read them only from there. The old env vars are copied in once,
// at boot, by importEnvKeys.

import type {Sql} from '../db.ts';
import type {Logger} from '../logger.ts';
import type {LlmKeys} from './index.ts';
import type {Provider} from './ref.ts';

export const PROVIDERS: readonly Provider[] = ['openrouter', 'anthropic', 'openai'];

export const MAX_KEY_LENGTH = 500;

/** The env var each provider's key used to come from; read only by importEnvKeys. */
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
  /** A stored key exists. */
  configured: boolean;
  /** Last 4 characters of the stored key. */
  last4: string | null;
  /** The tracker can call this provider; the same as `configured` now that only stored keys count. */
  available: boolean;
  /** 'stored' when a key is stored. Once 'env' as well, so the ERP still reads it as a union. */
  source: 'stored' | null;
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
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The stored keys, re-read at most once per TTL, which is how a key the
   * ERP pushes reaches every worker without a restart.
   */
  async get(): Promise<LlmKeys> {
    if (this.cache && this.now() - this.cachedAt < this.ttlMs) return this.cache;

    const keys: LlmKeys = {};
    for (const row of await this.rows()) keys[row.provider] = row.api_key;

    this.cache = keys;
    this.cachedAt = this.now();
    return keys;
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

  /** Each provider's stored key, as GET /api/llm-keys shows it. */
  async summary(): Promise<KeySummary[]> {
    const stored = new Map((await this.rows()).map((r) => [r.provider, r.api_key]));
    return PROVIDERS.map((provider) => {
      const key = stored.get(provider);
      return {
        provider,
        configured: key !== undefined,
        last4: key === undefined ? null : key.slice(-4),
        available: key !== undefined,
        source: key !== undefined ? 'stored' : null,
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

/**
 * Copies each env key into llm_keys, once per provider ever: the
 * llm_keys_env_imported row it writes outlives a later DELETE from the ERP,
 * so a removed key never comes back from a leftover variable. A key already
 * stored (pushed by the ERP) wins and is left alone. Any process may run it,
 * so a worker with a key the api lacks still brings it in. Returns the
 * providers whose key it stored; never throws, so a boot goes on without it.
 */
export async function importEnvKeys(
  sql: Sql,
  envKeys: LlmKeys,
  logger: Pick<Logger, 'info' | 'error'>,
): Promise<Provider[]> {
  const imported: Provider[] = [];
  for (const provider of PROVIDERS) {
    const key = envKeys[provider]?.trim();
    if (!key) continue;
    if (invalidKeyReason(key)) {
      logger.error(`${KEY_ENV[provider]} is not a usable key; not imported`, {provider});
      continue;
    }
    try {
      const stored = await sql.begin(async (tx) => {
        const [claimed] = await tx<Array<{provider: Provider}>>`
          INSERT INTO llm_keys_env_imported (provider) VALUES (${provider})
          ON CONFLICT (provider) DO NOTHING
          RETURNING provider`;
        if (!claimed) return false;
        const rows = await tx`
          INSERT INTO llm_keys (provider, api_key, updated_at) VALUES (${provider}, ${key}, NOW())
          ON CONFLICT (provider) DO NOTHING
          RETURNING provider`;
        return rows.length > 0;
      });
      if (stored) imported.push(provider);
    } catch (e) {
      logger.error(`could not import ${KEY_ENV[provider]}; will retry on the next boot`, {
        provider,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (imported.length > 0) {
    logger.info('LLM keys imported from env; the env vars are no longer read', {providers: imported});
  }
  return imported;
}
