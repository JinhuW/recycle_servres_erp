// Environment configuration. Secrets and per-machine facts live here;
// anything you would want to change while the fleet is running lives in the
// `settings` table instead (see settings.ts).

import {hostname} from 'node:os';
import 'dotenv/config';
import type {AlertTransport} from './alerts.ts';
import type {UserCredentials} from './userSender.ts';

export type Role = 'worker' | 'api';

export interface Config {
  readonly databaseUrl: string;
  readonly openrouterApiKey: string;
  readonly alertTransport: AlertTransport;
  readonly telegramBotToken: string;
  readonly role: Role;
  readonly workerId: string;
  readonly redditUserAgent: string;
  readonly redditMaxRpm: number;
  readonly apiPort: number;
  readonly apiToken: string;
  readonly logLevel: string;
  /** Whether this worker may hold the PM tracer lease (loops/trace.ts). */
  readonly commentTracer: boolean;
  /** The ops alert relay's POST /alert; both unset turns the api's watch off. */
  readonly opsAlertUrl: string;
  readonly opsAlertToken: string;
  /** Buyer alerts go out as this user account when set (userSender.ts). */
  readonly telegramUser: UserCredentials | null;
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

  // `console` prints alerts to stdout instead of messaging anyone — useful
  // before a bot token exists, and it makes the bot token optional.
  const alertTransport: AlertTransport =
    process.env['ALERT_TRANSPORT'] === 'console' ? 'console' : 'telegram';

  const opsAlertUrl = process.env['OPS_ALERT_URL'] ?? '';
  const opsAlertToken = process.env['OPS_ALERT_TOKEN'] ?? '';
  if (Boolean(opsAlertUrl) !== Boolean(opsAlertToken)) {
    throw new Error('OPS_ALERT_URL and OPS_ALERT_TOKEN are set together or not at all');
  }

  // The user account buyer alerts go out as, for their read receipts. All
  // three or none; only the api opens the session (see userSender.ts).
  const userEnv = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_USER_SESSION'].map((k) => process.env[k] ?? '');
  if (userEnv.some(Boolean) && !userEnv.every(Boolean)) {
    throw new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_USER_SESSION are set together or not at all');
  }
  const telegramUser = userEnv[0] ? {apiId: Number(userEnv[0]), apiHash: userEnv[1]!, session: userEnv[2]!} : null;
  if (telegramUser && !Number.isInteger(telegramUser.apiId)) {
    throw new Error(`TELEGRAM_API_ID must be a number, got "${userEnv[0]}"`);
  }

  return {
    databaseUrl: required('DATABASE_URL', role),
    alertTransport,
    // The API role never calls OpenRouter, but it does expose a Telegram test
    // endpoint, so only the key it cannot use is optional there.
    openrouterApiKey: role === 'worker' ? required('OPENROUTER_API_KEY', role) : (process.env['OPENROUTER_API_KEY'] ?? ''),
    telegramBotToken: alertTransport === 'telegram'
      ? required('TELEGRAM_BOT_TOKEN', role)
      : (process.env['TELEGRAM_BOT_TOKEN'] ?? ''),
    role,
    workerId: process.env['WORKER_ID'] || generateWorkerId(),
    redditUserAgent: process.env['REDDIT_USER_AGENT'] || DEFAULT_USER_AGENT,
    redditMaxRpm,
    apiPort,
    apiToken: role === 'api' ? required('API_TOKEN', role) : (process.env['API_TOKEN'] ?? ''),
    logLevel: process.env['LOG_LEVEL'] || 'info',
    commentTracer: process.env['COMMENT_TRACER'] !== 'off',
    opsAlertUrl,
    opsAlertToken,
    telegramUser,
  };
}
