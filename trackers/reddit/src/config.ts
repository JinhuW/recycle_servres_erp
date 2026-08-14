// Environment configuration. Secrets and per-machine facts live here;
// anything you would want to change while the fleet is running lives in the
// `settings` table instead (see settings.ts).

import {hostname} from 'node:os';
import 'dotenv/config';

export type Role = 'worker' | 'api';

export interface Config {
  readonly databaseUrl: string;
  readonly openrouterApiKey: string;
  readonly telegramBotToken: string;
  readonly role: Role;
  readonly workerId: string;
  readonly redditUserAgent: string;
  readonly redditMaxRpm: number;
  readonly apiPort: number;
  readonly apiToken: string;
  readonly logLevel: string;
}

const DEFAULT_USER_AGENT = 'recycle-servers-tracker/1.0 (contact: develop.jinhu@gmail.com)';

function required(name: string, role: Role): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (role=${role}). Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function generateWorkerId(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${hostname()}-${process.pid}-${suffix}`;
}

/**
 * Reads and validates configuration, failing fast on a misconfigured boot
 * rather than surfacing a missing key mid-loop hours later.
 */
export function loadConfig(): Config {
  const role: Role = process.env['ROLE'] === 'api' ? 'api' : 'worker';

  const apiPort = Number(process.env['API_PORT'] ?? 8080);
  if (!Number.isFinite(apiPort) || apiPort <= 0) {
    throw new Error(`API_PORT must be a positive number, got "${process.env['API_PORT']}"`);
  }

  // Reddit's anonymous bucket refills roughly every 40 s, so one request per
  // minute is the sustainable ceiling for a single IP. Throughput comes from
  // adding VMs, not from raising this. See the debug note in docs/.
  const redditMaxRpm = Number(process.env['REDDIT_MAX_RPM'] ?? 1);
  if (!Number.isFinite(redditMaxRpm) || redditMaxRpm <= 0) {
    throw new Error(`REDDIT_MAX_RPM must be a positive number, got "${process.env['REDDIT_MAX_RPM']}"`);
  }

  return {
    databaseUrl: required('DATABASE_URL', role),
    // The API role never calls OpenRouter, but it does expose a Telegram test
    // endpoint, so only the key it cannot use is optional there.
    openrouterApiKey: role === 'worker' ? required('OPENROUTER_API_KEY', role) : (process.env['OPENROUTER_API_KEY'] ?? ''),
    telegramBotToken: required('TELEGRAM_BOT_TOKEN', role),
    role,
    workerId: process.env['WORKER_ID'] || generateWorkerId(),
    redditUserAgent: process.env['REDDIT_USER_AGENT'] || DEFAULT_USER_AGENT,
    redditMaxRpm,
    apiPort,
    apiToken: role === 'api' ? required('API_TOKEN', role) : (process.env['API_TOKEN'] ?? ''),
    logLevel: process.env['LOG_LEVEL'] || 'info',
  };
}
