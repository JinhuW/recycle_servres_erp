// What the agent keeps under /state: the last desired answer, for ticks the
// ERP cannot be reached; the little memory the stagger, the crash limit, the
// holds and the stop handoff need to survive an agent restart; and the
// agent's instance id.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { HoldEntry } from './plan.js';
import { EMPTY_DESIRED, parseDesired, type Desired } from './types.js';

const DESIRED_FILE = 'desired.json';
const MEMORY_FILE = 'memory.json';
const INSTANCE_FILE = 'instance-id';

export interface StopIdentity {
  account_no: number;
  epoch: number;
  restart: boolean;
  confirmed?: boolean;
}
export interface Memory {
  pending: Record<string, StopIdentity>;
  last_start_at: number | null;
  restarts: Record<string, number[]>;
  soft_restarts: Record<string, number[]>;
  held: Record<string, HoldEntry>;
  self_stopped: Record<string, number>;
}

export function emptyMemory(): Memory {
  return { last_start_at: null, restarts: {}, soft_restarts: {}, pending: {}, held: {}, self_stopped: {} };
}

function writePrivate(path: string, text: string): void {
  // Write beside and rename over: a reader sees the old file or the new one.
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function times(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!isObject(raw)) return out;
  for (const [id, list] of Object.entries(raw)) {
    if (Array.isArray(list)) out[id] = list.filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  }
  return out;
}

export function loadMemory(dir: string): Memory {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, MEMORY_FILE), 'utf8'));
    if (!isObject(parsed)) return emptyMemory();
    raw = parsed;
  } catch {
    return emptyMemory();
  }
  const pending: Record<string, StopIdentity> = {};
  if (isObject(raw.pending)) {
    for (const [id, p] of Object.entries(raw.pending)) {
      if (!isObject(p) || !Number.isInteger(p.account_no) || !Number.isInteger(p.epoch) || typeof p.restart !== 'boolean') continue;
      pending[id] = { account_no: p.account_no as number, epoch: p.epoch as number, restart: p.restart, ...(p.confirmed === true ? { confirmed: true } : {}) };
    }
  }
  const held: Record<string, HoldEntry> = {};
  if (isObject(raw.held)) {
    for (const [id, h] of Object.entries(raw.held)) {
      if (isObject(h) && typeof h.container === 'string' && (h.reason === 'crash_limit' || h.reason === 'operator_stopped')) {
        held[id] = { container: h.container, reason: h.reason };
      }
    }
  }
  const selfStopped: Record<string, number> = {};
  if (isObject(raw.self_stopped)) {
    for (const [id, t] of Object.entries(raw.self_stopped)) if (typeof t === 'number' && Number.isFinite(t)) selfStopped[id] = t;
  }
  return {
    pending,
    last_start_at: typeof raw.last_start_at === 'number' && Number.isFinite(raw.last_start_at) ? raw.last_start_at : null,
    restarts: times(raw.restarts),
    soft_restarts: times(raw.soft_restarts),
    held,
    self_stopped: selfStopped,
  };
}

export function saveMemory(dir: string, memory: Memory): void {
  writePrivate(join(dir, MEMORY_FILE), JSON.stringify(memory));
}

/** This agent's id: made once, kept with its state, so two agents for one host can tell each other apart. */
export function loadInstanceId(dir: string): string {
  try {
    const id = readFileSync(join(dir, INSTANCE_FILE), 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } catch {
    // made below
  }
  const id = randomUUID();
  try {
    writePrivate(join(dir, INSTANCE_FILE), id);
  } catch {
    // An unwritable /state is reported by the first memory write.
  }
  return id;
}

export { EMPTY_DESIRED };
