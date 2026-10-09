// Which RAM and SSD spec values can sit on one line together.
//
// The forms filter a select by the fields it depends on, a pick that makes
// another field impossible fixes or clears it, and the backend refuses a save
// that would store a conflict. All three read the tables below, so the UI can
// never produce a line the API turns away.
//
// Form (`classification`) and Device (`type`) are peers rather than parent and
// child: purchasers pick Device first ("Desktop → UDIMM") while the label
// scanner reads Form, and filtering each list by the other deadlocks — on a
// SODIMM + Laptop line no RDIMM could be reached without blanking a field. So
// whichever of the two was set last wins and fixes the other, and neither list
// is filtered.
//
// A rule judges only values its table names. Blank and unknown values (legacy
// `type: 'DDR4'`, a bare `M.2`) restrict nothing, and a rule fires only when one
// of its own fields changes — prod holds conflicting lines from before these
// rules, and a price edit on one must still save.
//
// A pairing is refused only when no DDR3–DDR5 part with it was ever sold. Prod
// lines are no evidence either way: many are label scans that misread the rank
// or the form.

type SpecValue = string | null | undefined;

/** The spec fields the cascade reads and writes, in their camelCase spelling. */
export type CascadeSpec = {
  generation?: SpecValue;
  classification?: SpecValue;
  type?: SpecValue;
  rank?: SpecValue;
  interface?: SpecValue;
  formFactor?: SpecValue;
};

export type CascadeField = keyof CascadeSpec;

/** Every field a rule reads — what a brand-new line counts as changed. */
export const CASCADE_FIELDS: readonly CascadeField[] =
  ['generation', 'classification', 'type', 'rank', 'interface', 'formFactor'];

// The first device is what a Form fills in. UDIMM may still be Server: ECC
// UDIMMs go into entry servers, and prod holds them.
const FORM_DEVICES: Readonly<Record<string, readonly string[]>> = {
  UDIMM: ['Desktop', 'Server'],
  RDIMM: ['Server'],
  LRDIMM: ['Server'],
  SODIMM: ['Laptop'],
  CAMM: ['Laptop'],
};
const DEVICES = ['Desktop', 'Server', 'Laptop'];
const FORM_GENERATIONS: Readonly<Record<string, readonly string[]>> = { CAMM: ['DDR5'] };
const GENERATIONS = ['DDR2', 'DDR3', 'DDR4', 'DDR5'];

/**
 * What a rank asks of its module, smallest first: `any` fits every module,
 * `dimm` needs a full-size one, and `buffered` a registered or load-reduced one.
 */
export type RankNeed = 'any' | 'dimm' | 'buffered';
const RANK_NEEDS: readonly RankNeed[] = ['any', 'dimm', 'buffered'];
// The richest rank each unbuffered module or device takes. x4 and four ranks
// reach a full-size UDIMM (DDR3 "AMD only" 2Rx4, DDR5 4Rx8 CQDIMM) but no
// SODIMM or CAMM ever sold; registered memory and servers take anything.
const RANK_LIMITS: Readonly<Record<string, RankNeed>> = {
  UDIMM: 'dimm', SODIMM: 'any', CAMM: 'any', DESKTOP: 'dimm', LAPTOP: 'any',
};

// LFF SAS SSDs are 2.5" drives in a 3.5" carrier, sold under 3.5" part numbers.
const SSD_INTERFACE_FORMS: Readonly<Record<string, readonly string[]>> = {
  SATA: ['2.5"', '3.5"', 'M.2 2230', 'M.2 2280', 'M.2 22110'],
  SAS: ['2.5"', '3.5"'],
  NVME: ['2.5"', 'M.2 2230', 'M.2 2280', 'M.2 22110', 'U.2', 'AIC'],
  'U.2': ['U.2', '2.5"'],
};
// What picking an interface fills into a blank form factor: its only form, or
// the one nearly every drive of that interface has.
const SSD_DEFAULT_FORM: Readonly<Record<string, string>> = { SAS: '2.5"' };
const SSD_INTERFACES = ['SATA', 'SAS', 'NVMe', 'U.2'];
const SSD_FORMS = [...new Set(Object.values(SSD_INTERFACE_FORMS).flat())];

/**
 * The values the tables name, per field. Anything else is unknown and passes;
 * a catalog option missing here is a rule nobody wrote.
 */
export const CASCADE_VOCABULARY: Readonly<Record<Exclude<CascadeField, 'rank'>, readonly string[]>> = {
  generation: GENERATIONS,
  classification: Object.keys(FORM_DEVICES),
  type: DEVICES,
  interface: SSD_INTERFACES,
  formFactor: SSD_FORMS,
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const keyOf = (v: unknown): string => text(v).toUpperCase();
const has = (list: readonly string[], v: unknown): boolean => list.some((x) => keyOf(x) === keyOf(v));

// `1Rx8`, `2Rx4`, `4DRx4`, `2S2Rx4` (3DS).
const RANK = /^(\d+)(S\d+)?(D)?RX(\d+)$/;

/**
 * The module a rank needs. Dual-die (`DR`), 3DS, octal and quad-rank x4 are
 * registered-only; other x4 and quad ranks need a full-size DIMM. Null for a
 * spelling the pattern doesn't know.
 */
export function rankNeeds(rank: SpecValue): RankNeed | null {
  const m = keyOf(rank).match(RANK);
  if (!m) return null;
  const ranks = Number(m[1]);
  const x4 = Number(m[4]) === 4;
  if (m[2] || m[3] || ranks >= 8 || (ranks >= 4 && x4)) return 'buffered';
  return x4 || ranks >= 4 ? 'dimm' : 'any';
}

/** Whether `form` exists in `generation`; null when either is unknown. */
function formFitsGeneration(form: SpecValue, generation: SpecValue): boolean | null {
  const gens = FORM_GENERATIONS[keyOf(form)];
  if (!gens || !has(GENERATIONS, generation)) return null;
  return has(gens, generation);
}

/** Whether `device` fits `form`; null when either is unknown. */
function deviceFitsForm(form: SpecValue, device: SpecValue): boolean | null {
  const devices = FORM_DEVICES[keyOf(form)];
  if (!devices || !has(DEVICES, device)) return null;
  return has(devices, device);
}

/**
 * The richest rank this line's Form and Device both take, and the field that
 * sets it; null when neither limits the rank.
 */
function rankLimit(spec: CascadeSpec): { mark: string; need: RankNeed } | null {
  let out: { mark: string; need: RankNeed } | null = null;
  for (const v of [spec.classification, spec.type]) {
    const need = RANK_LIMITS[keyOf(v)];
    if (need && (!out || RANK_NEEDS.indexOf(need) < RANK_NEEDS.indexOf(out.need))) {
      out = { mark: text(v), need };
    }
  }
  return out;
}

/** Whether `rank` fits the line's module; null when either is unknown. */
function rankFits(spec: CascadeSpec, rank: SpecValue): boolean | null {
  const limit = rankLimit(spec);
  const need = rankNeeds(rank);
  if (!limit || !need) return null;
  return RANK_NEEDS.indexOf(need) <= RANK_NEEDS.indexOf(limit.need);
}

/** Whether `formFactor` fits the SSD `iface`; null when either is unknown. */
function ssdFormFits(iface: SpecValue, formFactor: SpecValue): boolean | null {
  const forms = SSD_INTERFACE_FORMS[keyOf(iface)];
  if (!forms || !has(SSD_FORMS, formFactor)) return null;
  return has(forms, formFactor);
}

/**
 * The options a spec select should offer, given the rest of the line. Options
 * the tables don't know are always kept.
 */
export function allowedOptions(
  category: string,
  field: CascadeField,
  spec: CascadeSpec,
  options: readonly string[],
): readonly string[] {
  if (category === 'RAM' && field === 'classification') {
    return options.filter((o) => formFitsGeneration(o, spec.generation) !== false);
  }
  if (category === 'RAM' && field === 'rank') {
    return options.filter((o) => rankFits(spec, o) !== false);
  }
  if (category === 'SSD' && field === 'formFactor') {
    return options.filter((o) => ssdFormFits(spec.interface, o) !== false);
  }
  return options;
}

/**
 * `patch` plus whatever it implies for the rest of the line: a field it made
 * impossible is cleared (`''`), and a field it settles is filled in. Only keys
 * whose value changes are added, and a rule runs only when one of its own
 * fields changed — so a Brand edit leaves a legacy conflict alone.
 */
export function cascadePatch<T extends CascadeSpec>(
  category: string,
  spec: T,
  patch: Partial<T>,
): Partial<T> {
  const out: Record<string, unknown> = { ...patch };
  const cur = (f: CascadeField): SpecValue => (f in out ? out[f] : spec[f]) as SpecValue;
  const changed = (f: CascadeField) => f in out && text(out[f]) !== text(spec[f]);
  const put = (f: CascadeField, v: string) => {
    if (text(cur(f)) !== v) out[f] = v;
  };
  const now = (): CascadeSpec => ({ ...spec, ...out } as CascadeSpec);

  if (category === 'RAM') {
    // Generation outranks Form: a scan that reads DDR4 next to CAMM is wrong
    // about the module, not about the generation.
    if ((changed('generation') || changed('classification'))
      && formFitsGeneration(cur('classification'), cur('generation')) === false) {
      put('classification', '');
    }

    const form = cur('classification');
    const formSet = text(form) !== '';
    if (changed('classification') && formSet) {
      // Form wins when both moved at once — a scan reads Form off the label.
      const devices = FORM_DEVICES[keyOf(form)];
      if (devices && !has(devices, cur('type'))) put('type', devices[0]);
    } else if ((changed('type') || (changed('generation') && !formSet)) && has(DEVICES, cur('type'))) {
      const device = cur('type');
      const forms = Object.keys(FORM_DEVICES).filter((f) =>
        has(FORM_DEVICES[f], device) && formFitsGeneration(f, cur('generation')) !== false);
      if (!formSet || (FORM_DEVICES[keyOf(form)] && !has(forms, form))) {
        put('classification', forms.length === 1 ? forms[0] : '');
      }
    }

    if ((changed('classification') || changed('type') || changed('rank'))
      && rankFits(now(), cur('rank')) === false) {
      put('rank', '');
    }
  }

  if (category === 'SSD' && (changed('interface') || changed('formFactor'))) {
    if (ssdFormFits(cur('interface'), cur('formFactor')) === false) put('formFactor', '');
    const iface = keyOf(cur('interface'));
    const fill = SSD_DEFAULT_FORM[iface]
      ?? (SSD_INTERFACE_FORMS[iface]?.length === 1 ? SSD_INTERFACE_FORMS[iface][0] : undefined);
    if (changed('interface') && fill && text(cur('formFactor')) === '') put('formFactor', fill);
  }

  return out as Partial<T>;
}

/**
 * The first rule `merged` breaks, judging only rules with a field in
 * `changed`; null when the line is consistent as far as this save goes.
 */
export function specConflicts(
  category: string,
  merged: CascadeSpec,
  changed: ReadonlySet<string>,
): string | null {
  const touched = (...fields: CascadeField[]) => fields.some((f) => changed.has(f));
  const { generation, classification: form, type: device, rank } = merged;

  if (category === 'RAM') {
    if (touched('generation', 'classification') && formFitsGeneration(form, generation) === false) {
      return `${text(form)} is ${FORM_GENERATIONS[keyOf(form)].join(' or ')} only, not ${text(generation)}`;
    }
    if (touched('classification', 'type') && deviceFitsForm(form, device) === false) {
      return `${text(device)} doesn't fit ${text(form)} (${text(form)} is ${FORM_DEVICES[keyOf(form)].join(' or ')})`;
    }
    if (touched('classification', 'type', 'rank') && rankFits(merged, rank) === false) {
      const why = rankNeeds(rank) === 'buffered' ? 'is a server rank' : 'needs a full-size DIMM';
      return `${text(rank)} ${why} and doesn't fit ${rankLimit(merged)!.mark}`;
    }
  }

  if (category === 'SSD' && touched('interface', 'formFactor')
    && ssdFormFits(merged.interface, merged.formFactor) === false) {
    return `${text(merged.formFactor)} doesn't fit a ${text(merged.interface)} SSD`;
  }
  return null;
}
