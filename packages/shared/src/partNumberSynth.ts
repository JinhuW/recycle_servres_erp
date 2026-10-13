// Synthetic part numbers.
//
// Some lines arrive without a manufacturer part number — most often a batch of
// assorted-brand SSDs entered as one "Mixed" line. Rather than leave the field
// blank (which breaks inventory grouping and reference pricing, both keyed on
// the part number), we derive a stable synthetic id from the line's own specs.
//
// The rules are declarative on purpose: adding a new generated field — another
// category, a different trigger, a different component set — is a data edit to
// SYNTH_PN_RULES, not a new code branch. Keep it that way.

// Structural view of a line — only the fields synth rules read. Extend as new
// rules need new fields.
export type SynthLine = {
  brand?: string | null;
  capacity?: string | null;
  interface?: string | null;
  formFactor?: string | null;
  generation?: string | null;
  type?: string | null;
  speed?: string | null;
  rpm?: string | number | null;
};

// When `guard` matches a line, build `${prefix}_${parts…}` from the listed
// fields, skipping blanks — unless `requireAll`, where any blank means no
// part number at all. One rule per category.
export type SynthRule = {
  guard: (line: SynthLine) => boolean;
  prefix: string;
  parts: readonly (keyof SynthLine)[];
  requireAll?: boolean;
};

const isMixedBrand = (l: SynthLine) => (l.brand ?? '').trim().toLowerCase() === 'mixed';

// DDR3 is end-of-life stock that trades by capacity and module form, so a
// line needs only those two to be saved, and a lot without a label part
// number is filed by them. The forms' required-field rule reads this too, so
// what counts as DDR3 is decided once.
export const isDdr3 = (generation?: string | null): boolean =>
  (generation ?? '').trim().toUpperCase() === 'DDR3';

// A part number is a single token: no spaces, no quotes. Component values from
// the catalog carry both (e.g. `2.5"`, `M.2 2280`), so drop quote/prime marks
// and fold any internal whitespace into hyphens (underscore is the segment
// separator). "2.5\"" → "2.5", "M.2 2280" → "M.2-2280".
function sanitizeSegment(v: string): string {
  return v
    .replace(/["'′″]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export const SYNTH_PN_RULES: Partial<Record<string, SynthRule>> = {
  SSD: { guard: isMixedBrand, prefix: 'MIXED', parts: ['capacity', 'interface', 'formFactor'] },
  // Only the two fields a DDR3 line must carry, so lots filled to different
  // depths still land in one inventory product. Both or nothing: a lot with
  // one of them blank is not yet a product, and filing it under `DDR3_8GB`
  // would split it from the complete `DDR3_8GB_Server` it belongs with.
  RAM: { guard: (l) => isDdr3(l.generation), prefix: 'DDR3', parts: ['capacity', 'type'], requireAll: true },
  // Future: HDD → ['capacity','interface','formFactor'], …
};

// Derive a synthetic part number for `line`, or null if no rule applies. This
// is a pure fallback: it does NOT consider whether the line already has a part
// number — callers apply it only when the field is empty so a typed/OCR value
// always wins.
export function synthesizePartNumber(category: string, line: SynthLine): string | null {
  const rule = SYNTH_PN_RULES[category];
  if (!rule || !rule.guard(line)) return null;
  const all = rule.parts.map((k) => sanitizeSegment(String(line[k] ?? '')));
  const segs = all.filter(Boolean);
  if (segs.length === 0 || (rule.requireAll && segs.length < all.length)) return null;
  return [rule.prefix, ...segs].join('_');
}
