// Append-only JSONL sink for unhandled errors, separate from the Docker
// container's stdout stream. Each record is one JSON object per line so the
// file is greppable and tail-friendly. When errors.jsonl crosses maxBytes it's
// renamed errors-YYYYMMDD-HHMMSS.jsonl and a fresh file starts; the oldest
// rotated files past maxFiles are pruned. All writes go through a single
// promise chain so concurrent calls can't interleave bytes within a line.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface ErrorRecord {
  ts: string;
  requestId: string;
  method?: string;
  path?: string;
  query?: string;
  userId?: number | string;
  userEmail?: string;
  message: string;
  stack?: string;
}

export interface AppendOptions {
  maxBytes?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const LIVE_FILE = 'errors.jsonl';

let chain: Promise<unknown> = Promise.resolve();

export function _resetForTests(): void {
  chain = Promise.resolve();
}

export function appendErrorRecord(
  dir: string,
  record: ErrorRecord,
  options: AppendOptions = {},
): Promise<void> {
  const next = chain.then(() => writeOne(dir, record, options)).catch((err) => {
    // Last-resort surface: the sink must never throw out of app.onError.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'error',
      message: 'error-log sink failed',
      error: err instanceof Error ? err.message : String(err),
    }));
  });
  chain = next;
  return next;
}

async function writeOne(dir: string, record: ErrorRecord, options: AppendOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  await fs.mkdir(dir, { recursive: true });
  const livePath = join(dir, LIVE_FILE);
  const line = JSON.stringify(record) + '\n';

  const size = await fileSize(livePath);
  // Rotate when the file has reached the cap. Overshoot is bounded by the
  // line that triggered the threshold — that line lives in the rotated file
  // and the live file restarts empty on the next call.
  if (size >= maxBytes) {
    await rotate(dir, livePath, maxFiles);
  }

  await fs.appendFile(livePath, line, 'utf8');
}

async function fileSize(path: string): Promise<number> {
  try {
    const st = await fs.stat(path);
    return st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function rotate(dir: string, livePath: string, maxFiles: number): Promise<void> {
  const stamp = timestamp();
  const target = join(dir, `errors-${stamp}.jsonl`);
  await fs.rename(livePath, target);
  await pruneOldest(dir, maxFiles);
}

async function pruneOldest(dir: string, maxFiles: number): Promise<void> {
  const entries = await fs.readdir(dir);
  const rotated = entries.filter((f) => /^errors-\d{8}-\d{6}\.jsonl$/.test(f));
  if (rotated.length <= maxFiles) return;

  const withMtime = await Promise.all(
    rotated.map(async (name) => {
      const path = join(dir, name);
      const st = await fs.stat(path);
      return { path, mtime: st.mtimeMs };
    }),
  );
  withMtime.sort((a, b) => a.mtime - b.mtime);
  const toDelete = withMtime.slice(0, withMtime.length - maxFiles);
  await Promise.all(toDelete.map((e) => fs.unlink(e.path).catch(() => {})));
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}
