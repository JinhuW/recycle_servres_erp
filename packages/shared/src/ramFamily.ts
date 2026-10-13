// The RAM module a part number names, with the maker's trailing packaging,
// marking and PCB-lot codes dropped — the key Inventory's grouped view merges
// lots under.
//
// M393A2K43BB1-CTD, -CTD7Q and -CTDQ are one stick: the same module code,
// dies, organisation and speed, with a suffix that says how it was boxed or
// which line built it. Read as plain canonical part numbers they were three
// products. What is kept is everything up to and including the speed (and
// Micron's die revision, which follows it), so a different module form
// (393 RDIMM vs 391 ECC UDIMM, PZ vs PDZ vs AZ), die, organisation or speed
// still separates two parts.
//
// A part number none of the schemes reads gets no family, and the caller keeps
// grouping it by its canonical part number. Kingston's server suffixes
// (KSM26RD8/16HDI vs …MEI) name the dies, so Kingston is deliberately absent.

import { canonicalPartNumber, stripPartPrefix } from './partNumberCanon.js';
import { splitRamPartFamily } from './ramPartDecode.js';

export type RamFamily = {
  /** Grouping key; equal for two part numbers of the same module. */
  key: string;
  /** How many leading characters of the canonical part number the key keeps. */
  length: number;
};

// M393A2K43BB1-CTD7Q: M · module (393) · generation (A) · depth (2K) ·
// organisation (43) · die rev, package, PCB (BB1) · temp/power (C) · speed
// (TD) · suffix (7Q).
const SAMSUNG_RE = /^M[34]\d\d[ABR]\w{2}\w{2}\w{3}[A-Z][A-Z][A-Z0-9]/;

// HMA82GR7CJR8N-VK: everything before the dash, then the two-letter speed.
// Written without the dash, the organisation digit and the letter after it
// mark where the speed starts.
const HYNIX_HEAD_RE = /^HM[AT][1-58A]\w\w[URLSPV][67]\w+$/;
const HYNIX_NODASH_RE = /^HM[AT][1-58A]\w\w[URLSPV][67]\w\w[A-Z][468][A-Z][A-Z][A-Z0-9]/;

// MTA36ASF2G72PZ-2G1A2II: chips · family · depth · width · module · speed ·
// die revision (A2) · marking (II).
const MICRON_RE = /^MTA?\d{1,2}[A-Z]{2,3}(?:256|512|1G|2G|4G|8G|16G)(?:64|72)[A-Z0-9]*?Z[123]G\d[A-Z]\d/;

function hynixLength(raw: string, canon: string): number | null {
  const body = stripPartPrefix(raw).trim().toUpperCase();
  // The first dash after a whole head, not the last: a dashed packaging tail
  // (…-VK-TF) must key the same as its dash-free spelling (…-VKTF).
  for (let dash = body.indexOf('-'); dash > 0; dash = body.indexOf('-', dash + 1)) {
    const head = canonicalPartNumber(body.slice(0, dash));
    const speed = canonicalPartNumber(body.slice(dash + 1)).slice(0, 2);
    if (HYNIX_HEAD_RE.test(head) && /^[A-Z][A-Z0-9]$/.test(speed)) return head.length + 2;
  }
  return canon.match(HYNIX_NODASH_RE)?.[0].length ?? null;
}

/** The module family of a RAM part number; null when no scheme reads it. */
export function ramFamily(raw: string | null | undefined): RamFamily | null {
  if (!raw) return null;
  const canon = canonicalPartNumber(raw);
  const length = canon.match(SAMSUNG_RE)?.[0].length
    ?? (canon.startsWith('HM') ? hynixLength(raw, canon) : null)
    ?? canon.match(MICRON_RE)?.[0].length
    ?? null;
  if (length == null) return null;
  return { key: `ram:${canon.slice(0, length)}`, length };
}

/**
 * The family as a reader sees it: the part number as written, cut where the
 * family ends, with `*` standing for the suffixes it covers —
 * `M393A2K43BB1-CTD*`.
 */
export function ramFamilyLabel(raw: string, family: RamFamily): string {
  return `${splitRamPartFamily(raw, family.length)[0]}*`;
}

// DDR5 trades by spec, not by stick: a buyer asking for Samsung 32GB 2Rx4
// 4800 RDIMM takes M321R4GA3BB6-CQK and -CQKET alike, and the family rule
// above reads only three makers anyway. So a DDR5 lot keys on the six fields
// the buyer names — brand, device type, capacity, rank, speed, module form —
// and the part number drops out. Blank keys on blank: a lot missing its rank
// is its own product rather than a guess at one.

export type Ddr5SpecRow = {
  category?: unknown; generation?: unknown; brand?: unknown; type?: unknown;
  capacity?: unknown; rank?: unknown; speed?: unknown; classification?: unknown;
};

const DDR5_KEY_FIELDS = ['brand', 'type', 'capacity', 'rank', 'speed', 'classification'] as const;

const norm = (v: unknown): string =>
  v == null ? '' : String(v).trim().toUpperCase().replace(/\s+/g, ' ');

/** The spec key of a DDR5 RAM line; null for any other line. */
export function ddr5SpecKey(r: Ddr5SpecRow): string | null {
  if (r.category !== 'RAM' || norm(r.generation) !== 'DDR5') return null;
  return `ddr5:${DDR5_KEY_FIELDS.map((f) => norm(r[f])).join('|')}`;
}
