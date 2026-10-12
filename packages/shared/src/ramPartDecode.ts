// What a RAM part number says about the stick, read from the maker's own
// part-numbering scheme.
//
// A label scan or a purchaser's hand fills Brand, Capacity, Generation, Form,
// Device, Rank and Speed one select at a time, and the part number printed on
// the same label already encodes most of them. Decoding it lets the forms fill
// what's blank and flag a line whose specs contradict its own part number —
// the 2026-10-11 audit found 350 of 2,023 prod RAM lots in that state.
//
// The schemes are the makers' published decoders (Samsung, SK Hynix, Micron
// and Crucial, Kingston) plus the consumer kits that reach us often (G.Skill,
// Corsair). Each field is given only where the part number fixes it; a field
// the scheme leaves open (an ECC UDIMM's device, a die density the code
// doesn't name) is left out rather than guessed, and a part number no scheme
// matches decodes to null. Kingston and HP OEM numbers (9995…, KKRVFX…) carry
// no spec at all.
//
// The part number itself is often the misread part (HMAA vs HMA8, PZ vs PDZ,
// O for 0), so a disagreement on a form is a question for the person holding
// the stick, never an automatic overwrite. Only a label scan corrects itself,
// and only when its own printed specs pick the one reading (reconcileRamScan).

import { canonicalPartNumber, stripPartPrefix } from './partNumberCanon.js';

export type RamPartSpec = {
  brand?: string;
  capacity?: string;
  generation?: string;
  type?: string;
  classification?: string;
  rank?: string;
  speed?: string;
};

export type RamPartField = keyof RamPartSpec;

export const RAM_PART_FIELDS: readonly RamPartField[] =
  ['brand', 'capacity', 'generation', 'classification', 'type', 'rank', 'speed'];

export type RamPartDecode = {
  /** The leading characters of the canonical part number that name the module family. */
  familyLength: number;
  spec: RamPartSpec;
  /**
   * Set when the part number as written decoded to nothing, or to less, and
   * one misread character away decoded fully: that reading, spelled as written.
   */
  readAs?: string;
};

type Form = 'UDIMM' | 'ECC-UDIMM' | 'RDIMM' | 'LRDIMM' | 'SODIMM' | 'ECC-SODIMM';

// An ECC UDIMM goes in a desktop or an entry server, so its device is open.
const FORM_SPEC: Readonly<Record<Form, Pick<RamPartSpec, 'classification' | 'type'>>> = {
  UDIMM: { classification: 'UDIMM', type: 'Desktop' },
  'ECC-UDIMM': { classification: 'UDIMM' },
  RDIMM: { classification: 'RDIMM', type: 'Server' },
  LRDIMM: { classification: 'LRDIMM', type: 'Server' },
  SODIMM: { classification: 'SODIMM', type: 'Laptop' },
  'ECC-SODIMM': { classification: 'SODIMM', type: 'Laptop' },
};

// DDR3 speeds are stored as the PC3 module rate, the way the label prints them.
const DDR3_PC_RATE: Readonly<Record<string, string>> = {
  '800': '6400', '1066': '8500', '1333': '10600', '1600': '12800', '1866': '14900', '2133': '17000',
};

function speedFor(generation: string, mts: string | undefined): string | undefined {
  if (!mts) return undefined;
  return generation === 'DDR3' ? DDR3_PC_RATE[mts] ?? mts : mts;
}

// A DDR4 or DDR5 label can print its rate the same way (PC4-25600), and a
// scan keeps the number as printed. None of these collides with a transfer
// rate, so they fold back whatever the generation.
const PC_RATE_MTS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(DDR3_PC_RATE).map(([mts, pc]) => [pc, mts])),
  '19200': '2400', '21300': '2666', '23400': '2933', '25600': '3200',
  '38400': '4800', '41600': '5200', '44800': '5600', '48000': '6000', '51200': '6400',
};

/**
 * The module's MT/s, folding a PC module rate back to its transfer rate so
 * `12800` and `1600` (or `25600` and `3200`) compare equal.
 */
export function ramSpeedMts(speed: string | null | undefined): string {
  const s = (speed ?? '').trim().toUpperCase().replace(/^PC\d?L?-?/, '').replace(/MHZ$|MT\/S$/, '').trim();
  return PC_RATE_MTS[s] ?? s;
}

/** `8` → `8GB`, and a fractional or zero size → undefined. */
function gb(n: number): string | undefined {
  return Number.isInteger(n) && n > 0 ? `${n}GB` : undefined;
}

/**
 * The rank a module of `capacityGb` built from `dieGb` dies `width` bits wide
 * must have: data bits over 64 per rank. Undefined when it isn't whole.
 */
function rankOf(capacityGb: number, dieGbit: number, width: number): string | undefined {
  const chips = (capacityGb * 8) / dieGbit;
  const ranks = (chips * width) / 64;
  return Number.isInteger(ranks) && ranks >= 1 && ranks <= 8 ? `${ranks}Rx${width}` : undefined;
}

// Depth codes shared by Samsung and SK Hynix: the module's depth in words of
// 64 bits, so the capacity in GB is depth × 8.
const DEPTH_GB: Readonly<Record<string, number>> = {
  '25': 2, '26': 2, '51': 4, '52': 4, '1G': 8, '1K': 8, '2G': 16, '2K': 16,
  '4G': 32, '4K': 32, '8G': 64, '8K': 64, 'AG': 128, 'AK': 128,
};

// ── Samsung ───────────────────────────────────────────────────────────────
// M393A2K40BB1-CRC0Q: M · 3 DIMM / 4 SODIMM · 93 module · A DDR4 (B DDR3,
// R DDR5) · 2K depth · 40 organisation · B die rev · B1 package/PCB ·
// C temp/power · RC speed.

const SAMSUNG_FORM: Readonly<Record<string, Form>> = {
  '378': 'UDIMM', '391': 'ECC-UDIMM', '393': 'RDIMM', '386': 'LRDIMM', '471': 'SODIMM', '474': 'ECC-SODIMM',
  '323': 'UDIMM', '324': 'ECC-UDIMM', '321': 'RDIMM', '425': 'SODIMM', '426': 'ECC-SODIMM',
};
const SAMSUNG_GEN: Readonly<Record<string, string>> = { B: 'DDR3', A: 'DDR4', R: 'DDR5' };
const SAMSUNG_SPEED: Readonly<Record<string, string>> = {
  // DDR3
  F7: '800', F8: '1066', H9: '1333', K0: '1600', MA: '1866', NB: '2133',
  // DDR4
  PB: '2133', RC: '2400', TD: '2666', VF: '2933', WE: '3200',
  // DDR5
  QK: '4800', WB: '5600', XN: '6400', SB: '5200', YF: '6400',
};
// DDR4/DDR5 organisation codes. DDR3 codes depend on the die and are left out.
const SAMSUNG_WIDTH: Readonly<Record<string, number>> = {
  '40': 4, '43': 8, '44': 16, A0: 4, A3: 8, B4: 16, B3: 8,
};

function samsung(pn: string): RamPartDecode | null {
  const m = pn.match(/^M([34]\d\d)([ABR])(\w\w)(\w\w)(\w)/);
  if (!m) return null;
  const form = SAMSUNG_FORM[m[1]];
  const generation = SAMSUNG_GEN[m[2]];
  if (!form || !generation) return null;
  const capGb = DEPTH_GB[m[3]];
  const spec: RamPartSpec = { brand: 'Samsung', generation, ...FORM_SPEC[form], capacity: capGb ? gb(capGb) : undefined };

  // Speed is the last two letters of the 3-letter group after the dash, after
  // a temperature/power letter (C, Y, H, …).
  const tail = pn.slice(m[0].length).match(/^\w{2,3}?([A-Z])([A-Z][A-Z0-9])/);
  if (tail) spec.speed = speedFor(generation, SAMSUNG_SPEED[tail[2]]);

  const width = SAMSUNG_WIDTH[m[4]];
  if (capGb && width && generation !== 'DDR3') {
    // DDR5 modules are built from 16Gb dies; DDR4 from 4Gb (depth "G" below
    // 8G), 8Gb ("K") or 16Gb (8G/AG with "G").
    const die = generation === 'DDR5' ? 16
      : m[3].endsWith('K') ? 8
      : m[3] === '8G' || m[3] === 'AG' ? 16
      : null;
    const rank = die ? rankOf(capGb, die, width) : undefined;
    // Four or more ranks of x4 on DDR4 are stacked dies: an LRDIMM prints
    // them as dual-die (4DRx4), an RDIMM is a 3DS part whose stacking the
    // number doesn't spell out.
    const stacked = rank && Number(rank[0]) >= 4 && generation === 'DDR4';
    if (rank && !stacked) spec.rank = rank;
    else if (stacked && form === 'LRDIMM') spec.rank = rank.replace('R', 'DR');
  }
  return { familyLength: m[0].length - 1, spec: clean(spec) };
}

// ── SK Hynix ──────────────────────────────────────────────────────────────
// HMA82GR7CJR4N-VK: HM · A DDR4 (T DDR3) · 8 die (4 = 4Gb, 8 = 8Gb, A = 16Gb)
// · 2G depth · R module · 7 ECC (6 none) · CJ die rev/package · R4 organisation
// · N · VK speed.

const HYNIX_FORM: Readonly<Record<string, readonly [Form, Form]>> = {
  // [non-ECC, ECC]
  U: ['UDIMM', 'ECC-UDIMM'], R: ['RDIMM', 'RDIMM'], L: ['LRDIMM', 'LRDIMM'],
  S: ['SODIMM', 'ECC-SODIMM'], P: ['RDIMM', 'RDIMM'],
  // VLP: a very-low-profile registered module, still an RDIMM.
  V: ['RDIMM', 'RDIMM'],
};
const HYNIX_DIE: Readonly<Record<string, number>> = { '4': 4, '8': 8, A: 16 };
const HYNIX_WIDTH: Readonly<Record<string, number>> = { '4': 4, '8': 8, '6': 16 };
const HYNIX_SPEED: Readonly<Record<string, string>> = {
  // DDR3
  G7: '1066', H9: '1333', PB: '1600', RD: '1866',
  // DDR4
  TF: '2133', UH: '2400', VK: '2666', WM: '2933', XN: '3200', AA: '3200',
};

function hynix(pn: string): RamPartDecode | null {
  const ddr5 = hynixDdr5(pn);
  if (ddr5) return ddr5;
  const m = pn.match(/^HM([AT])([1-58A])(\w\w)([URLSPV])([67])(\w\w)[A-Z]([468])/);
  if (!m) return null;
  const generation = m[1] === 'A' ? 'DDR4' : 'DDR3';
  const forms = HYNIX_FORM[m[4]];
  const capGb = DEPTH_GB[m[3]];
  const width = HYNIX_WIDTH[m[7]];
  const die = HYNIX_DIE[m[2]];
  const spec: RamPartSpec = {
    brand: 'SK Hynix',
    generation,
    ...FORM_SPEC[forms[m[5] === '7' ? 1 : 0]],
    capacity: capGb ? gb(capGb) : undefined,
    rank: capGb && width && die ? rankOf(capGb, die, width) : undefined,
  };
  // An LRDIMM's ranks are often stacked dies; the plain count misnames them.
  if (spec.classification === 'LRDIMM') delete spec.rank;
  const speed = pn.slice(m[0].length).match(/^[A-Z]?-?([A-Z][A-Z0-9])/);
  if (speed) spec.speed = speedFor(generation, HYNIX_SPEED[speed[1]]);
  return { familyLength: m[0].length, spec: clean(spec) };
}

// HMCG88MEBRA: HMC DDR5 · G 16Gb die · 8 module size (6 = 8GB … A = 128GB) ·
// 8 organisation · ME die rev · B · R module · A.
const HYNIX5_SIZE: Readonly<Record<string, number>> = { '6': 8, '7': 16, '8': 32, '9': 64, A: 128 };
const HYNIX5_FORM: Readonly<Record<string, Form>> = { R: 'RDIMM', U: 'UDIMM', E: 'ECC-UDIMM', S: 'SODIMM' };

function hynixDdr5(pn: string): RamPartDecode | null {
  const m = pn.match(/^HMC(G)([6-9A])([468])\w\w\w([RUES])/);
  if (!m) return null;
  const capGb = HYNIX5_SIZE[m[2]];
  const width = HYNIX_WIDTH[m[3]];
  const spec: RamPartSpec = {
    brand: 'SK Hynix',
    generation: 'DDR5',
    ...FORM_SPEC[HYNIX5_FORM[m[4]]],
    capacity: gb(capGb),
    rank: rankOf(capGb, 16, width),
  };
  return { familyLength: m[0].length, spec: clean(spec) };
}

// ── Micron ────────────────────────────────────────────────────────────────
// MTA18ASF2G72PDZ-2G3B1: MTA DDR4 module (MT DDR3) · 18 chips · ASF · 2G72
// depth × bus width · PDZ module (D = dual rank) · 2G3 speed · B1 revision.

const MICRON_FORM: Readonly<Record<string, Form>> = {
  AZ: 'UDIMM', AS: 'UDIMM', EZ: 'ECC-UDIMM', HZ: 'SODIMM', HS: 'SODIMM', TZ: 'ECC-SODIMM',
  PZ: 'RDIMM', PDZ: 'RDIMM', PSZ: 'RDIMM', PS: 'RDIMM', LZ: 'LRDIMM', LDZ: 'LRDIMM', LS: 'LRDIMM',
};
const MICRON_SPEED: Readonly<Record<string, string>> = {
  '1G0': '1066', '1G1': '1066', '1G4': '1333', '1G6': '1600', '1G9': '1866',
  '2G1': '2133', '2G3': '2400', '2G6': '2666', '2G9': '2933', '3G2': '3200',
};
const MICRON_DEPTH_GB: Readonly<Record<string, number>> = {
  '256': 0.25, '512': 0.5, '1G': 1, '2G': 2, '4G': 4, '8G': 8, '16G': 16,
};

function micron(pn: string): RamPartDecode | null {
  const crucial = crucialPart(pn);
  if (crucial) return crucial;
  const ddr5 = micronDdr5(pn);
  if (ddr5) return ddr5;
  const m = pn.match(/^MT(A?)(\d{1,2})([A-Z]{2,3})(256|512|1G|2G|4G|8G|16G)(64|72)(PDZ|PSZ|LDZ|[A-Z][A-Z])/);
  if (!m) return null;
  const generation = m[1] === 'A' ? 'DDR4' : 'DDR3';
  const form = MICRON_FORM[m[6]];
  if (!form) return null;
  const chips = Number(m[2]);
  const ecc = m[5] === '72';
  const capGb = MICRON_DEPTH_GB[m[4]] * 8;
  const spec: RamPartSpec = { brand: 'Micron', generation, ...FORM_SPEC[withEcc(form, ecc)], capacity: gb(capGb) };

  // Data chips × width = 64 × ranks. A "D" module is dual-rank x8; otherwise
  // the narrowest-sensible width the chip count allows: a registered module
  // with a full x4 set is x4, a 4-chip UDIMM/SODIMM is x16, the rest x8.
  const data = ecc ? (chips * 8) / 9 : chips;
  const registered = form === 'RDIMM' || form === 'LRDIMM';
  if (Number.isInteger(data) && form !== 'LRDIMM') {
    const width = m[6].includes('D') ? 8
      : registered && data % 16 === 0 ? 4
      : data === 4 ? 16
      : 8;
    const ranks = (data * width) / 64;
    if (Number.isInteger(ranks) && ranks >= 1) spec.rank = `${ranks}Rx${width}`;
  }
  const speed = pn.slice(m[0].length).match(/^([123]G\d)/);
  if (speed) spec.speed = speedFor(generation, MICRON_SPEED[speed[1]]);
  return { familyLength: m[0].length, spec: clean(spec) };
}

// MTC20F2085S1RC48BA1: MTC DDR5 module · 20 chips · F ECC (C none) · 2 ranks
// · 0 · 8 width · 5 · S1 · RC module · 48 speed.
const MICRON5_FORM: Readonly<Record<string, readonly [Form, Form]>> = {
  U: ['UDIMM', 'ECC-UDIMM'], R: ['RDIMM', 'RDIMM'], S: ['SODIMM', 'ECC-SODIMM'],
};

function micronDdr5(pn: string): RamPartDecode | null {
  const m = pn.match(/^MTC(\d{1,2})([CF])([1-4])0([48]|16)\d\w\d([URS])C(\d\d)/);
  if (!m) return null;
  const chips = Number(m[1]);
  const ecc = m[2] === 'F';
  const data = ecc ? (chips * 8) / 10 : chips;
  const width = Number(m[4]);
  const ranks = Number(m[3]);
  // 16Gb dies: data chips × 2GB.
  const capGb = Number.isInteger(data) && (data * width) / 64 === ranks ? data * 2 : undefined;
  const spec: RamPartSpec = {
    brand: 'Micron',
    generation: 'DDR5',
    ...FORM_SPEC[MICRON5_FORM[m[5]][ecc ? 1 : 0]],
    capacity: capGb ? gb(capGb) : undefined,
    rank: `${ranks}Rx${width}`,
    speed: `${m[6]}00`,
  };
  return { familyLength: m[0].length - 2, spec: clean(spec) };
}

// Crucial (Micron's retail brand): CT8G4DFS824A, CT8G4DFD8213, CT16G48C40U5.
// The catalog has no Crucial and purchasers file it under Micron or Other,
// so the brand is left open.
function crucialPart(pn: string): RamPartDecode | null {
  const d5 = pn.match(/^CT(\d+)G(\d\d)C\d\d([US])5/);
  if (d5) {
    return {
      familyLength: d5[0].length,
      spec: clean({
        generation: 'DDR5', capacity: gb(Number(d5[1])),
        ...FORM_SPEC[d5[3] === 'U' ? 'UDIMM' : 'SODIMM'], speed: `${d5[2]}00`,
      }),
    };
  }
  const m = pn.match(/^CT(\d+)G([34])([DSR])F([SDQ]?)([468]?)[A-Z]?(213|266|293|13|16|18|21|24|26|29|32)/);
  if (!m) return null;
  const generation = m[2] === '3' ? 'DDR3' : 'DDR4';
  const form: Form = m[3] === 'D' ? 'UDIMM' : m[3] === 'S' ? 'SODIMM' : 'RDIMM';
  const ranks = { S: 1, D: 2, Q: 4 }[m[4]];
  const spec: RamPartSpec = {
    generation, capacity: gb(Number(m[1])), ...FORM_SPEC[form],
    rank: ranks && m[5] ? `${ranks}Rx${WIDTH_DIGIT[m[5]]}` : undefined,
    speed: speedFor(generation, CRUCIAL_SPEED[m[6]]),
  };
  return { familyLength: m[0].length, spec: clean(spec) };
}
const CRUCIAL_SPEED: Readonly<Record<string, string>> = {
  '13': '1333', '16': '1600', '18': '1866', '21': '2133', '24': '2400', '26': '2666', '29': '2933', '32': '3200',
  '213': '2133', '266': '2666', '293': '2933',
};

// Kingston and Crucial write the chip width as one digit: 6 is x16.
const WIDTH_DIGIT: Readonly<Record<string, number>> = { '4': 4, '8': 8, '6': 16 };

// ── Kingston ──────────────────────────────────────────────────────────────
// KVR26N19S8/8, KSM32RD4/32HDR, KCP426NS8/8, KVR48U40BS8-16: speed (2 or 3
// digits), module letter, rank (S/D/Q) and width, then "/" or "-" and the size.
// DDR3L adds an L, after the speed (KVR16LR11D4/16) or after KCP3
// (KCP3L16SD8/8): a voltage, not a module letter.
const KINGSTON_FORM: Readonly<Record<string, Form>> = {
  N: 'UDIMM', U: 'UDIMM', E: 'ECC-UDIMM', S: 'SODIMM', R: 'RDIMM', L: 'LRDIMM', ES: 'ECC-SODIMM',
};

function kingston(raw: string): RamPartDecode | null {
  // The size sits after a "/" or "-", which the canonical key drops, so read
  // the part as written.
  const pn = stripPartPrefix(raw).trim().toUpperCase().replace(/\s+/g, '');
  // KCP and KTx numbers carry the generation digit first: KCP426NS8/8.
  // A kit (…S8K2/16) names its total after the stick count, like the
  // consumer kits below: one stick is the size over the count.
  const m = pn.match(/^K(?:VR|SM|CP[345]L?|T[DLHW][345]|F)?(\d{2,3})L?(ES|[NUESRL])\d{0,2}[A-Z]?([SDQ])([468])\w*?(?:K(\d))?[/-](\d{1,3})/);
  if (!m) return null;
  const s = m[1];
  const mts = s.length === 3 ? `${s.slice(0, 2)}00`
    : { '13': '1333', '16': '1600', '18': '1866', '21': '2133', '24': '2400', '26': '2666', '29': '2933', '32': '3200',
      '48': '4800', '52': '5200', '56': '5600', '64': '6400' }[s];
  if (!mts) return null;
  const n = Number(mts);
  const generation = n >= 4800 ? 'DDR5' : n >= 2133 ? 'DDR4' : 'DDR3';
  const form = KINGSTON_FORM[m[2]];
  const ranks = { S: 1, D: 2, Q: 4 }[m[3]];
  const spec: RamPartSpec = {
    brand: 'Kingston', generation, ...FORM_SPEC[form], capacity: gb(Number(m[6]) / Number(m[5] ?? 1)),
    rank: ranks ? `${ranks}Rx${WIDTH_DIGIT[m[4]]}` : undefined, speed: speedFor(generation, mts),
  };
  // The family is everything before the size separator.
  const family = canonicalPartNumber(m[0].slice(0, m[0].search(/[/-]\d{1,3}$/)));
  return { familyLength: family.length, spec: clean(spec) };
}

// Kingston-built OEM modules: HP26D4U9S8HJ-8, HP32D4S2S8ME-8 — speed, D4 DDR4,
// U/S/R module, S/D rank and width, then the size after the dash.
function kingstonOem(raw: string): RamPartDecode | null {
  const pn = stripPartPrefix(raw).trim().toUpperCase().replace(/\s+/g, '');
  const m = pn.match(/^(?:HP|DL|LV|AC|SL|TS)(\d\d)D([345])([USR])(\w)([SD])([468])\w*-(\d{1,3})$/);
  if (!m) return null;
  const generation = `DDR${m[2]}`;
  const mts = { '21': '2133', '24': '2400', '26': '2666', '29': '2933', '32': '3200', '48': '4800', '52': '5200', '56': '5600' }[m[1]];
  // The digit after the module letter is 7 for an ECC module, as on SK Hynix.
  const form: Form = withEcc(m[3] === 'U' ? 'UDIMM' : m[3] === 'S' ? 'SODIMM' : 'RDIMM', m[4] === '7');
  const spec: RamPartSpec = {
    brand: 'Kingston', generation, ...FORM_SPEC[form], capacity: gb(Number(m[7])),
    rank: `${m[5] === 'S' ? 1 : 2}Rx${WIDTH_DIGIT[m[6]]}`, speed: speedFor(generation, mts),
  };
  return { familyLength: canonicalPartNumber(pn.replace(/-\d{1,3}$/, '')).length, spec: clean(spec) };
}

// ── Consumer kits ─────────────────────────────────────────────────────────
// G.Skill F4-3200C16D-32GVK and Corsair CMK16GX4M2B3000C15 name the whole
// kit's size and the stick count, so one stick is size ÷ count.

function gskill(raw: string): RamPartDecode | null {
  const pn = stripPartPrefix(raw).trim().toUpperCase();
  // DDR5 names the stick and the count: F5-6000J3636F16GX2-TZ5RK.
  const d5 = pn.match(/^F5-(\d{4})[A-Z]\d{4}F(\d+)GX(\d)/);
  if (d5) {
    return {
      familyLength: canonicalPartNumber(d5[0]).length,
      spec: clean({ generation: 'DDR5', capacity: gb(Number(d5[2])), speed: d5[1] }),
    };
  }
  const m = pn.match(/^F([34])-(\d{4})[A-Z]\d{2}(?:-\d{2}-\d{2})?([SDQO])-(\d+)G(RS)?/);
  if (!m) return null;
  const sticks = { S: 1, D: 2, Q: 4, O: 8 }[m[3]]!;
  const generation = `DDR${m[1]}`;
  return {
    familyLength: canonicalPartNumber(m[0]).length,
    spec: clean({
      generation, capacity: gb(Number(m[4]) / sticks), speed: speedFor(generation, m[2]),
      // Ripjaws SO-DIMM kits end in RS.
      ...(m[5] ? FORM_SPEC.SODIMM : {}),
    }),
  };
}

function corsair(pn: string): RamPartDecode | null {
  const m = pn.match(/^CM([A-Z]{1,3})(\d+)GX([345])M(\d)[A-Z](\d{4})/);
  if (!m) return null;
  const generation = `DDR${m[3]}`;
  const spec: RamPartSpec = {
    generation, capacity: gb(Number(m[2]) / Number(m[4])), speed: speedFor(generation, m[5]),
    ...(m[1].startsWith('S') ? FORM_SPEC.SODIMM : {}),
  };
  return { familyLength: m[0].length, spec: clean(spec) };
}

/** A 72-bit unbuffered module is the ECC flavour of its form. */
function withEcc(form: Form, ecc: boolean): Form {
  if (!ecc) return form;
  return form === 'UDIMM' ? 'ECC-UDIMM' : form === 'SODIMM' ? 'ECC-SODIMM' : form;
}

function clean(spec: RamPartSpec): RamPartSpec {
  const out: RamPartSpec = {};
  for (const f of RAM_PART_FIELDS) if (spec[f]) out[f] = spec[f];
  return out;
}

/**
 * Whether the part number decodes as written, if only in part. One that
 * doesn't may still decode one look-alike away, but it may as well be a
 * scheme this decoder doesn't know, so nothing should rewrite it unasked.
 */
export function ramPartDecodesAsWritten(raw: string | null | undefined): boolean {
  return !!raw && decodeExact(raw) !== null;
}

function decodeExact(raw: string): RamPartDecode | null {
  const pn = canonicalPartNumber(raw);
  if (pn.length < 6) return null;
  const out = samsung(pn) ?? hynix(pn) ?? micron(pn) ?? corsair(pn)
    ?? kingston(raw) ?? kingstonOem(raw) ?? gskill(raw);
  return out && Object.keys(out.spec).length > 0 ? out : null;
}

// What a label read (AI or eye) confuses each character with. The pairs are
// the ones the 2026-10-11 audit found in prod: O for 0 in Samsung suffixes,
// HMAA read as HMA8, and the rest of the usual glyph look-alikes.
const LOOKALIKES: Readonly<Record<string, string>> = {
  O: '0DQ', '0': 'OD8', D: '0O', Q: '0O', I: '1L', L: '1I', '1': 'IL7', '7': '1',
  S: '58', '5': 'S', B: '8', '8': 'BA0', A: '84', '4': 'A', Z: '2', '2': 'Z',
  G: '6C', '6': 'G8', C: 'G0', U: 'V', V: 'U', M: 'N', N: 'MH', H: 'N',
};

/**
 * The part number one misread away: every single look-alike substitution,
 * plus Micron's dropped or doubled rank letter (PZ ↔ PDZ). Separators and a
 * leading label are kept where they were, so a Kingston size still parses.
 */
export function ramPartLookalikes(raw: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    for (const c of LOOKALIKES[raw[i].toUpperCase()] ?? '') out.push(raw.slice(0, i) + c + raw.slice(i + 1));
  }
  if (/PDZ/i.test(raw)) out.push(raw.replace(/PDZ/i, 'PZ'));
  else if (/PZ/i.test(raw)) out.push(raw.replace(/PZ/i, 'PDZ'));
  return out;
}

/**
 * The spec the part number fixes, and how much of it named the family; null
 * when no maker's scheme recognises it. A part number no scheme takes is
 * tried one misread character away, and the first reading that decodes is
 * used and named in `readAs`.
 */
export function decodeRamPart(raw: string | null | undefined): RamPartDecode | null {
  if (!raw) return null;
  const exact = decodeExact(raw);
  if (exact && exact.spec.rank && exact.spec.speed) return exact;
  // A misread can also leave the number decodable but short a field — the O
  // in M393A2K4OBB1 still matches Samsung, minus its rank. A reading that
  // keeps every field and adds one is the better one.
  for (const alt of ramPartLookalikes(raw)) {
    const d = decodeExact(alt);
    if (d && (!exact || extends_(d.spec, exact.spec))) return { ...d, readAs: alt };
  }
  return exact;
}

/** Every distinct reading one misread away that decodes further than `raw` as written. */
function readingsBeyond(raw: string): string[] {
  const exact = decodeExact(raw);
  const seen = new Map<string, string>();
  for (const alt of ramPartLookalikes(raw)) {
    const d = decodeExact(alt);
    if (!d || (exact && !extends_(d.spec, exact.spec))) continue;
    const key = canonicalPartNumber(alt);
    if (!seen.has(key)) seen.set(key, alt);
  }
  return [...seen.values()];
}

/** Whether `more` names every field `base` does, the same, and at least one more. */
function extends_(more: RamPartSpec, base: RamPartSpec): boolean {
  let extra = false;
  for (const f of RAM_PART_FIELDS) {
    if (base[f] && base[f] !== more[f]) return false;
    if (more[f] && !base[f]) extra = true;
  }
  return extra;
}

/**
 * Readings of `raw` one misread away whose decode agrees with every field the
 * line names, when the part number as written contradicts the line. They are
 * what to offer when the label photo, not the form, may be what's wrong.
 */
export function ramPartReadingsMatching(
  raw: string | null | undefined,
  line: Partial<Record<RamPartField, string | null | undefined>>,
): string[] {
  const base = decodeRamPart(raw);
  if (!raw || !base || ramPartMismatches(base, line).length === 0) return [];
  const seen = new Map<string, string>();
  for (const alt of ramPartLookalikes(raw)) {
    const d = decodeExact(alt);
    if (!d || ramPartMismatches(d, line).length > 0) continue;
    // A reading that only agrees because it decodes to less proves nothing.
    if (RAM_PART_FIELDS.some((f) => base.spec[f] && !d.spec[f])) continue;
    const key = canonicalPartNumber(alt);
    if (!seen.has(key)) seen.set(key, alt);
  }
  return [...seen.values()].slice(0, 3);
}

export type RamScanCheck = {
  /** The part number replaced by a reading one misread character away. */
  partCorrected?: { from: string; to: string };
  /** Blank fields the part number filled. */
  filled: RamPartField[];
  /** What the label's printed specs and its part number still disagree on. */
  conflicts: RamPartMismatch[];
};

/**
 * Cross-checks one label read against itself: the model read the part number
 * and the printed specs separately, so where they agree both are probably
 * right, and where they don't one of them is misread.
 *
 * - A part number one look-alike away from a reading that agrees with every
 *   printed spec is corrected to it — two independent reads now agree, and
 *   that is the commonest OCR slip (O for 0, HMAA read as HMA8).
 * - Blank fields are filled from the (corrected) part number.
 * - Anything still contradicting is reported, never overwritten: which side
 *   is wrong is for a second photo or the person holding the stick to say.
 */
export function reconcileRamScan(fields: Record<string, string>): {
  fields: Record<string, string>;
  check: RamScanCheck | null;
} {
  const pn = fields.partNumber?.trim();
  if (!pn) return { fields, check: null };
  const out = { ...fields };
  const check: RamScanCheck = { filled: [], conflicts: [] };

  let decode = decodeRamPart(pn);
  if (!decode) return { fields, check: null };
  // Read only through a look-alike, the part number may be right and the
  // decoder short of its scheme: a correction then needs the printed specs
  // to pick it, and the look-alike's specs prove nothing on their own.
  const asWritten = ramPartDecodesAsWritten(pn);
  if (ramPartMismatches(decode, out).length > 0) {
    const readings = ramPartReadingsMatching(pn, out);
    // Two readings that both fit leave nothing to choose between.
    if (readings.length === 1) {
      out.partNumber = readings[0];
      decode = decodeRamPart(readings[0])!;
    } else if (!asWritten) {
      return { fields, check: null };
    }
  } else if (decode.readAs) {
    if (!asWritten) return { fields, check: null };
    // decodeRamPart takes the first reading that decodes further; when two
    // different ones do, the label hasn't said which, so the part number
    // stays as read and only what it decodes to as written is used.
    if (readingsBeyond(pn).length === 1) out.partNumber = decode.readAs;
    else decode = decodeExact(pn)!;
  }
  if (out.partNumber !== fields.partNumber) {
    check.partCorrected = { from: fields.partNumber, to: out.partNumber };
  }

  const fill = ramPartFill(decode, out);
  for (const f of RAM_PART_FIELDS) {
    if (fill[f]) { out[f] = fill[f]!; check.filled.push(f); }
  }
  check.conflicts = ramPartMismatches(decode, out);
  return { fields: out, check };
}

const norm = (f: RamPartField, v: string | null | undefined): string => {
  const t = (v ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return f === 'speed' ? ramSpeedMts(t) : t;
};

/** Whether two values of `field` name the same thing (`12800` and `1600` do). */
export function ramFieldsAgree(field: RamPartField, a: string | null | undefined, b: string | null | undefined): boolean {
  return norm(field, a) === norm(field, b);
}

export type RamPartMismatch = { field: RamPartField; partSays: string; lineSays: string };

/**
 * The fields where the line names a value its part number contradicts. Blank
 * line fields aren't mismatches — they're for the decode to fill.
 */
export function ramPartMismatches(
  decode: RamPartDecode | null,
  line: Partial<Record<RamPartField, string | null | undefined>>,
): RamPartMismatch[] {
  if (!decode) return [];
  const out: RamPartMismatch[] = [];
  for (const f of RAM_PART_FIELDS) {
    const partSays = decode.spec[f];
    const lineSays = line[f]?.trim() ?? '';
    if (!partSays || !lineSays) continue;
    // Brand "Other" is what a purchaser picks for an off-catalog maker; a
    // decode naming a catalog brand is still worth raising.
    if (norm(f, partSays) !== norm(f, lineSays)) out.push({ field: f, partSays, lineSays });
  }
  return out;
}

/** The decoded values for the line's blank fields. */
export function ramPartFill(
  decode: RamPartDecode | null,
  line: Partial<Record<RamPartField, string | null | undefined>>,
): RamPartSpec {
  const out: RamPartSpec = {};
  if (!decode) return out;
  for (const f of RAM_PART_FIELDS) {
    if (decode.spec[f] && !(line[f] ?? '').trim()) out[f] = decode.spec[f];
  }
  return out;
}

/**
 * Splits `raw` at the end of the decoded family, counting only the characters
 * the canonical key keeps — so `M393A2K40BB1-CRC0Q` with a family of 9 splits
 * into `M393A2K40` and `BB1-CRC0Q`, label prefix and all left in the head.
 */
export function splitRamPartFamily(raw: string, familyLength: number): [string, string] {
  const body = stripPartPrefix(raw);
  const lead = raw.length - body.length;
  let kept = 0;
  for (let i = 0; i < body.length; i++) {
    if (kept === familyLength) return [raw.slice(0, lead + i), raw.slice(lead + i)];
    if (!/[\s_-]/.test(body[i])) kept++;
  }
  return [raw, ''];
}
