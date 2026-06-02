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
  speed?: string | null;
  rpm?: string | number | null;
};

// When `guard` matches a line, build `${prefix}_${parts…}` from the listed
// fields, skipping blanks. One rule per category.
export type SynthRule = {
  guard: (line: SynthLine) => boolean;
  prefix: string;
  parts: readonly (keyof SynthLine)[];
};

const isMixedBrand = (l: SynthLine) => (l.brand ?? '').trim().toLowerCase() === 'mixed';

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
  // Future: HDD → ['capacity','interface','formFactor'], RAM → ['capacity','generation','speed'], …
};

// Derive a synthetic part number for `line`, or null if no rule applies. This
// is a pure fallback: it does NOT consider whether the line already has a part
// number — callers apply it only when the field is empty so a typed/OCR value
// always wins.
export function synthesizePartNumber(category: string, line: SynthLine): string | null {
  const rule = SYNTH_PN_RULES[category];
  if (!rule || !rule.guard(line)) return null;
  const segs = rule.parts.map((k) => sanitizeSegment(String(line[k] ?? ''))).filter(Boolean);
  return segs.length ? [rule.prefix, ...segs].join('_') : null;
}
