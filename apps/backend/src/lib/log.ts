// The backend's only log surface. Every line is a single JSON object carrying
// the release version and commit, so a log excerpt pasted into a bug report is
// self-identifying — you never have to correlate a timestamp against the deploy
// history to learn which build produced it. Callers never pass the version;
// it is stamped here, which is the whole point of routing through this module
// instead of console.*.
//
//   log.info('backend listening', { port });
//   log.error('r2 delete failed', err);           // Error → { error, stack }
//   const rlog = log.child({ requestId });        // fields inherited by every
//   rlog.warn('slow query', { ms: 1200 });        // line from that logger
//
// KEEP THIS MODULE FREE OF INTRA-REPO IMPORTS. The boot scripts under
// scripts/ are .mjs run by plain `node` (see the Dockerfile CMD); they import
// this file directly and rely on Node's TypeScript type-stripping. That works
// only while every import here is a node: builtin — the rest of src/ uses
// extensionless specifiers, which bare node cannot resolve.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  /** Returns a logger that stamps `fields` onto every line it emits. */
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  return (configured && LEVEL_RANK[configured]) || LEVEL_RANK.info;
}

// The release version lives in the ROOT package.json (bumped on every dev
// push), not the backend's own package.json (pinned at 0.1.0). The workspace
// root ships in the image (pnpm needs it to install), so reading it at runtime
// works on Railway, where no release-time build args are passed.
let rootVersionCache: string | undefined;
export function readRootVersion(): string {
  if (rootVersionCache === undefined) {
    let version = 'unknown';
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(join(here, '..', '..', '..', '..', 'package.json'), 'utf8'));
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch {
      // Fall through to 'unknown' — logging must never fail on provenance.
    }
    rootVersionCache = version;
  }
  return rootVersionCache;
}

// APP_VERSION / GIT_SHA are release-time Docker build args (scripts/release.sh).
// Railway never passes them and the Dockerfile bakes them as EMPTY strings, so
// `||` — not `??` — is what falls through to the root package.json version
// (bumped on every dev push, shipped in the image) and Railway's commit sha.
// Read per call rather than cached: tests flip these to assert both paths, and
// an env read is far cheaper than the line's JSON.stringify anyway.
export function releaseVersion(): string {
  return process.env.APP_VERSION || readRootVersion();
}

export function releaseCommit(): string {
  return process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown';
}

// An Error's message/stack are the interesting part; anything else structured
// is merged as-is so callers can attach domain context without a wrapper.
// An array is not merged — spreading one would produce "0", "1", … keys.
function toFields(detail: unknown): LogFields {
  if (detail === undefined || detail === null) return {};
  if (detail instanceof Error) return { error: detail.message, stack: detail.stack };
  if (typeof detail === 'object' && !Array.isArray(detail)) return detail as LogFields;
  return { detail };
}

function emit(level: LogLevel, base: LogFields, message: string, detail: unknown): void {
  if (LEVEL_RANK[level] < threshold()) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    version: releaseVersion(),
    commit: releaseCommit(),
    message,
    ...base,
    ...toFields(detail),
  });

  // The only sanctioned console use in the backend. warn/error go to stderr so
  // log routing can split them from the request stream.
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function make(base: LogFields): Logger {
  return {
    debug: (message, detail) => emit('debug', base, message, detail),
    info: (message, detail) => emit('info', base, message, detail),
    warn: (message, detail) => emit('warn', base, message, detail),
    error: (message, detail) => emit('error', base, message, detail),
    child: (fields) => make({ ...base, ...fields }),
  };
}

export const log: Logger = make({});
