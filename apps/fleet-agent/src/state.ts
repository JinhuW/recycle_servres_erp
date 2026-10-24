// What the agent keeps under /state: the last desired answer, for ticks the
// ERP cannot be reached, and the little memory the stagger and the crash
// limit need to survive an agent restart.

import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_DESIRED, parseDesired, type Desired } from './types.js';

const DESIRED_FILE = 'desired.json';
const MEMORY_FILE = 'memory.json';

export interface Memory {
  last_start_at: number | null;
  restarts: Record<string, number[]>;
}

function writePrivate(path: string, text: string): void {
  // Write beside and rename over: a reader sees the old file or the new one.
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.writing`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveDesired(dir: string, desired: Desired): void {
  writePrivate(join(dir, DESIRED_FILE), JSON.stringify(desired, null, 1));
}

export function loadDesired(dir: string): Desired | null {
  try {
    return parseDesired(JSON.parse(readFileSync(join(dir, DESIRED_FILE), 'utf8')));
  } catch {
    return null;
  }
}

export function loadMemory(dir: string): Memory {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MEMORY_FILE), 'utf8')) as Partial<Memory>;
    const restarts: Record<string, number[]> = {};
    for (const [id, times] of Object.entries(raw.restarts ?? {})) {
      if (Array.isArray(times)) restarts[id] = times.filter((t) => typeof t === 'number');
    }
    return { last_start_at: typeof raw.last_start_at === 'number' ? raw.last_start_at : null, restarts };
  } catch {
    return { last_start_at: null, restarts: {} };
  }
}

export function saveMemory(dir: string, memory: Memory): void {
  writePrivate(join(dir, MEMORY_FILE), JSON.stringify(memory));
}

export { EMPTY_DESIRED };
