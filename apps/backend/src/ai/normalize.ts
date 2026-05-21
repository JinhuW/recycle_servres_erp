// src/ai/normalize.ts
//
// Vision models emit values that are *almost* right but don't match the
// catalog vocabulary the UI dropdowns are built from: "32 GB" instead of
// "32GB", "4800 MT/s" instead of "4800", and — most often — the DDR
// generation dumped into `type` with `generation` left blank.
//
// Those near-misses are invisible in the UI: a native <select> whose value
// isn't one of its <option>s renders empty, so the field looks like it never
// got extracted (and a saved line looks "not prefilled" when reopened).
//
// This module canonicalises extracted fields deterministically so they land
// on the exact catalog strings. It is pure and DB-free: the rules *produce*
// the canonical form rather than fuzzy-matching against a fetched catalog,
// so it is safe to run on every scan with no extra query.

import type { LineCategory } from '../types';

const DEVICE_TYPES = new Set(['Desktop', 'Server', 'Laptop']);

// SODIMM → Laptop, UDIMM → Desktop, RDIMM/LRDIMM/ECC → Server.
function deviceTypeFromClass(classification: string | undefined): string | undefined {
  const c = (classification ?? '').toUpperCase();
  if (c === 'SODIMM') return 'Laptop';
  if (c === 'UDIMM') return 'Desktop';
  if (c === 'RDIMM' || c === 'LRDIMM') return 'Server';
  return undefined;
}

// "32 GB" / "32gb" / "32 G" / "32GIG" → "32GB"; "1.92 TB" → "1.92TB".
function normCapacity(v: string): string {
  const m = v.replace(/\s+/g, '').toUpperCase().match(/^([\d.]+)(TB|GB|T|G)?$/);
  if (!m) return v.trim();
  const num = m[1].replace(/\.0+$/, '');
  const unit = m[2] === 'T' ? 'TB' : m[2] === 'G' || !m[2] ? 'GB' : m[2];
  return `${num}${unit}`;
}

// Strip units/labels, keep the bare MT/s number: "4800 MT/s" → "4800".
function digitsOnly(v: string): string {
  const m = v.match(/\d+/);
  return m ? m[0] : '';
}

// "DDR 4" / "ddr4" / "PC4" → "DDR4"; bare "4" → "DDR4".
function normGeneration(v: string): string | undefined {
  const up = v.toUpperCase();
  let m = up.match(/DDR\s*([2345])/);
  if (m) return `DDR${m[1]}`;
  m = up.match(/PC([2345])/);
  if (m) return `DDR${m[1]}`;
  m = up.match(/^([2345])$/);
  if (m) return `DDR${m[1]}`;
  return undefined;
}

// "2RX4" / "2 Rx 4" → "2Rx4".
function normRank(v: string): string {
  const m = v.toUpperCase().replace(/\s+/g, '').match(/^(\d)RX(\d+)$/);
  return m ? `${m[1]}Rx${m[2]}` : v.trim();
}

// "PN: ABC", "P/N ABC", "S/N: ABC" → "ABC".
function stripPartPrefix(v: string): string {
  return v.replace(/^\s*(?:P\s*\/?\s*N|S\s*\/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*/i, '').trim();
}

/**
 * Canonicalise a raw extraction so values match the catalog dropdowns.
 * Unknown/empty values are dropped (the UI treats absent === "not read").
 */
export function normalizeFields(
  category: LineCategory,
  raw: Record<string, string>,
): Record<string, string> {
  // Trim everything and drop blanks first.
  const f: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) {
    if (typeof val !== 'string') continue;
    const t = val.trim();
    if (t) f[k] = t;
  }

  if (f.capacity) f.capacity = normCapacity(f.capacity);
  if (f.partNumber) f.partNumber = stripPartPrefix(f.partNumber);

  if (category === 'RAM') {
    // The model frequently puts "DDR5" in `type` and leaves `generation`
    // blank. Recover: a DDR-looking `type` is really the generation.
    if (!f.generation && f.type && normGeneration(f.type)) {
      f.generation = f.type;
      delete f.type;
    }
    if (f.generation) {
      const g = normGeneration(f.generation);
      if (g) f.generation = g; else delete f.generation;
    }
    if (f.classification) f.classification = f.classification.toUpperCase();
    if (f.rank) f.rank = normRank(f.rank);
    if (f.speed) {
      const s = digitsOnly(f.speed);
      if (s) f.speed = s; else delete f.speed;
    }
    // Device type: keep if already valid, else derive from classification.
    if (!f.type || !DEVICE_TYPES.has(f.type)) {
      const derived = deviceTypeFromClass(f.classification);
      if (derived) f.type = derived; else if (f.type) delete f.type;
    }
  }

  if (category === 'SSD' || category === 'HDD') {
    if (f.interface) f.interface = f.interface.toUpperCase().replace('NVME', 'NVMe');
    if (f.rpm) {
      const r = digitsOnly(f.rpm);
      if (r) f.rpm = r; else delete f.rpm;
    }
  }

  return f;
}
