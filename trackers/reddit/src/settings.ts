// Runtime configuration held in the database rather than in env, so the API
// can change what the fleet does — which prompt it evaluates with, which model,
// who gets alerted — without redeploying 10 VMs.

import type {Sql} from './db.ts';

export interface Settings {
  evalPrompt: string;
  llmModel: string;
  telegramChatIds: string[];
  maxPostAgeHours: number;
}

/** Used only if a row is missing; migrations seed all four keys. */
const FALLBACKS: Settings = {
  evalPrompt: 'Decide whether this Reddit post is someone selling used server hardware.',
  llmModel: 'openai/gpt-4o-mini',
  telegramChatIds: [],
  maxPostAgeHours: 24,
};

const CACHE_TTL_MS = 60_000;

export const SETTING_KEYS = [
  'eval_prompt',
  'llm_model',
  'telegram_chat_ids',
  'max_post_age_hours',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

export class SettingsStore {
  private cache: Settings | null = null;
  private cachedAt = 0;

  constructor(
    private readonly sql: Sql,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Returns current settings, re-reading at most once per TTL. The cache is
   * why an API edit reaches every worker within a minute without any
   * cross-worker messaging.
   */
  async get(): Promise<Settings> {
    if (this.cache && this.now() - this.cachedAt < this.ttlMs) return this.cache;

    const rows = await this.sql<Array<{key: string; value: unknown}>>`
      SELECT key, value FROM settings`;
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    const chatIds = byKey.get('telegram_chat_ids');
    this.cache = {
      evalPrompt: asString(byKey.get('eval_prompt')) ?? FALLBACKS.evalPrompt,
      llmModel: asString(byKey.get('llm_model')) ?? FALLBACKS.llmModel,
      telegramChatIds: Array.isArray(chatIds) ? chatIds.map(String) : FALLBACKS.telegramChatIds,
      maxPostAgeHours: asNumber(byKey.get('max_post_age_hours')) ?? FALLBACKS.maxPostAgeHours,
    };
    this.cachedAt = this.now();
    return this.cache;
  }

  /** Writes a setting and drops the local cache so the next read is fresh. */
  async set(key: SettingKey, value: unknown): Promise<void> {
    await this.sql`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, ${this.sql.json(value as never)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
    this.invalidate();
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.sql<Array<{key: string; value: unknown}>>`
      SELECT key, value FROM settings ORDER BY key`;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
