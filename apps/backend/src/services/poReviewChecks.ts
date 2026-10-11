// What the AI review concludes about one PO line, from up to four witnesses:
// the line's own part number (decoded by the makers' schemes), what its label
// photo reads, what the web says the part number is, and the market value.
//
// Pure, so the rules can be tested without a model or a database. The worker
// (poAiReview.ts) gathers the witnesses; this decides what they add up to.
//
// No witness is trusted alone. The 2026-10-11 audit found the part number is
// often the misread part (HMAA/HMA8, PZ/PDZ, O for 0), so a decode that
// disagrees with the line while the label agrees with the line points at the
// part number, not the spec. Two witnesses agreeing against the line is an
// error; one is a warning.

import {
  RAM_PART_FIELDS,
  canonicalPartNumber,
  decodeRamPart,
  ramFieldsAgree,
  ramPartMismatches,
  ramPartReadingsMatching,
  type RamPartField,
} from '@recycle-erp/shared';

export type ReviewLine = {
  id: string;
  productNo: number | null;
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  formFactor: string | null;
  rpm: number | null;
  partNumber: string | null;
  qty: number;
  unitCost: number;
};

export type LabelRead = {
  /** Normalised label fields, keyed like LineFields. */
  fields: Record<string, string>;
  /** `scan`: what the model read when the line was scanned; `reread`: read again now. */
  read: 'scan' | 'reread';
  url: string | null;
};

export type WebSpec = { specs: Record<string, string>; sourceUrls: string[] };

export type MarketRef = { value: number; label: string };

export type FindingSource =
  | { kind: 'decoder'; partNumber: string; readAs?: string; value?: string }
  | { kind: 'label'; read: 'scan' | 'reread'; url: string | null; value?: string }
  | { kind: 'web'; urls: string[]; value?: string }
  | { kind: 'market'; value: number; label: string };

export type FindingCode =
  | 'spec_mismatch'
  | 'spec_blank'
  | 'pn_label_differs'
  | 'pn_misread'
  | 'pn_missing'
  | 'cost_missing'
  | 'above_market'
  | 'budget_exhausted';

export type Finding = {
  lineId: string | null;
  severity: 'error' | 'warn' | 'info';
  code: FindingCode;
  /** The LineFields key a manager's Apply writes, or null when there is nothing to apply. */
  field: string | null;
  currentValue: string | null;
  suggestedValue: string | null;
  message: string;
  confidence: number | null;
  sources: FindingSource[];
};

export type LineEvidence = { label?: LabelRead | null; web?: WebSpec | null; market?: MarketRef | null };

// Fields a non-RAM label or lookup names, compared as text.
const DRIVE_FIELDS = ['brand', 'capacity', 'interface', 'formFactor', 'rpm'] as const;

const flat = (v: unknown): string =>
  String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');

const lineNo = (l: ReviewLine) => (l.productNo != null ? `#${l.productNo}` : 'line');

function storedOf(l: ReviewLine, f: string): string {
  const v = (l as unknown as Record<string, unknown>)[f];
  return v == null ? '' : String(v).trim();
}

/**
 * Whether a line's part number is worth a web lookup: RAM that no maker's
 * scheme decodes, or a drive with no label read to check it against.
 */
export function needsWebLookup(l: ReviewLine, hasLabel: boolean): boolean {
  const pn = l.partNumber?.trim();
  if (!pn) return false;
  if (l.category === 'RAM') return decodeRamPart(pn) === null;
  return (l.category === 'SSD' || l.category === 'HDD') && !hasLabel;
}

/** A finding the label photo could settle: the line's identity or specs are in dispute. */
export function isDisputed(f: Finding): boolean {
  return f.severity !== 'info' && (f.code === 'spec_mismatch' || f.code.startsWith('pn_'));
}

export function checkLine(l: ReviewLine, ev: LineEvidence = {}): Finding[] {
  const out: Finding[] = [];
  if (l.category === 'RAM') out.push(...checkRam(l, ev));
  else out.push(...checkDrive(l, ev));

  if (!(l.unitCost > 0)) {
    out.push({
      lineId: l.id, severity: 'warn', code: 'cost_missing', field: null,
      currentValue: String(l.unitCost), suggestedValue: null,
      message: `${lineNo(l)} has no unit cost`, confidence: null, sources: [],
    });
  }
  if (ev.market && l.unitCost > ev.market.value) {
    out.push({
      lineId: l.id, severity: 'info', code: 'above_market', field: null,
      currentValue: String(l.unitCost), suggestedValue: null,
      message: `${lineNo(l)} paid $${l.unitCost} a unit, above its market value $${ev.market.value}`,
      confidence: null, sources: [{ kind: 'market', value: ev.market.value, label: ev.market.label }],
    });
  }
  return out;
}

function checkRam(l: ReviewLine, ev: LineEvidence): Finding[] {
  const out: Finding[] = [];
  const pn = l.partNumber?.trim() ?? '';
  const label = ev.label ?? null;
  const labelPn = label?.fields.partNumber?.trim() || '';
  const stored = Object.fromEntries(RAM_PART_FIELDS.map((f) => [f, storedOf(l, f)])) as Record<RamPartField, string>;

  // ── The part number itself.
  if (!pn) {
    out.push({
      lineId: l.id, severity: labelPn ? 'warn' : 'info', code: 'pn_missing', field: 'partNumber',
      currentValue: null, suggestedValue: labelPn || null,
      message: labelPn ? `${lineNo(l)} has no part number; its label reads ${labelPn}` : `${lineNo(l)} has no part number`,
      confidence: labelPn ? 0.6 : null,
      sources: labelPn ? [labelSource(label!, labelPn)] : [],
    });
  }
  const decode = pn ? decodeRamPart(pn) : null;
  let pnSuspect = false;
  if (pn && labelPn && canonicalPartNumber(labelPn) !== canonicalPartNumber(pn)) {
    // The label's own part number agreeing with the line's specs is the
    // strongest sign the stored one was typed or scanned wrong.
    const labelDecode = decodeRamPart(labelPn);
    const labelFits = labelDecode !== null && ramPartMismatches(labelDecode, stored).length === 0;
    out.push({
      lineId: l.id, severity: labelFits ? 'error' : 'warn', code: 'pn_label_differs', field: 'partNumber',
      currentValue: pn, suggestedValue: labelPn,
      message: `${lineNo(l)} part number is ${pn}; its label reads ${labelPn}`,
      confidence: labelFits ? 0.85 : 0.5,
      sources: [labelSource(label!, labelPn)],
    });
    pnSuspect = true;
  }

  // ── Each spec field against the decode and the label.
  if (decode || label) {
    for (const f of RAM_PART_FIELDS) {
      const s = stored[f];
      const d = decode?.spec[f];
      const lv = label?.fields[f]?.trim() || undefined;
      const dSrc = (): FindingSource => ({ kind: 'decoder', partNumber: pn, readAs: decode?.readAs, value: d });
      if (!s) {
        if (d && lv && !ramFieldsAgree(f, d, lv)) continue;
        const v = d ?? lv;
        if (!v) continue;
        out.push({
          lineId: l.id, severity: 'info', code: 'spec_blank', field: f,
          currentValue: null, suggestedValue: v,
          message: `${lineNo(l)} ${f} is blank; ${d ? 'the part number' : 'the label'} says ${v}`,
          confidence: d && lv ? 0.9 : 0.6,
          sources: [...(d ? [dSrc()] : []), ...(lv ? [labelSource(label!, lv)] : [])],
        });
        continue;
      }
      const dOff = !!d && !ramFieldsAgree(f, d, s);
      const lOff = !!lv && !ramFieldsAgree(f, lv, s);
      if (dOff && lOff && ramFieldsAgree(f, d, lv)) {
        out.push(mismatch(l, f, s, d!, 'error', 0.9, [dSrc(), labelSource(label!, lv!)],
          `the part number and the label both say ${d}`));
      } else if (dOff && lOff) {
        out.push(mismatch(l, f, s, lv!, 'warn', 0.4, [dSrc(), labelSource(label!, lv!)],
          `the label says ${lv}, the part number ${d}`));
      } else if (dOff && lv) {
        // The label backs the line: the part number is the likelier misread.
        pnSuspect = true;
      } else if (dOff) {
        out.push(mismatch(l, f, s, d!, 'warn', 0.6, [dSrc()], `the part number says ${d}`));
      } else if (lOff && !d) {
        out.push(mismatch(l, f, s, lv!, 'warn', 0.5, [labelSource(label!, lv!)], `the label says ${lv}`));
      }
      // lOff with a decode that backs the line: the label read is the misread.
    }
  }

  // ── A part number one look-alike away that fits every spec.
  if (pn && !out.some((x) => x.code === 'pn_label_differs')) {
    const decodeOff = decode !== null && ramPartMismatches(decode, stored).length > 0;
    const readings = pnSuspect || decodeOff ? ramPartReadingsMatching(pn, stored) : [];
    const readAs = decode?.readAs;
    const suggestion = readings.length === 1 ? readings[0]
      : readAs && !decodeOff ? readAs
      : null;
    if (suggestion && canonicalPartNumber(suggestion) !== canonicalPartNumber(pn)) {
      out.push({
        lineId: l.id, severity: 'warn', code: 'pn_misread', field: 'partNumber',
        currentValue: pn, suggestedValue: suggestion,
        message: `${lineNo(l)} part number ${pn} may be misread as ${suggestion}`,
        confidence: pnSuspect ? 0.7 : 0.5,
        sources: [{ kind: 'decoder', partNumber: pn, readAs: suggestion }],
      });
    }
  }

  // ── The web, for a part number no scheme decodes.
  if (!decode && ev.web) {
    for (const f of RAM_PART_FIELDS) {
      const s = stored[f];
      const w = ev.web.specs[f]?.trim();
      if (!w) continue;
      if (!s) {
        out.push({
          lineId: l.id, severity: 'info', code: 'spec_blank', field: f, currentValue: null, suggestedValue: w,
          message: `${lineNo(l)} ${f} is blank; the web says ${w}`, confidence: 0.5,
          sources: [{ kind: 'web', urls: ev.web.sourceUrls, value: w }],
        });
      } else if (!ramFieldsAgree(f, w, s)) {
        out.push(mismatch(l, f, s, w, 'warn', 0.5, [{ kind: 'web', urls: ev.web.sourceUrls, value: w }],
          `the web says ${w}`));
      }
    }
  }
  return out;
}

function checkDrive(l: ReviewLine, ev: LineEvidence): Finding[] {
  const out: Finding[] = [];
  const pn = l.partNumber?.trim() ?? '';
  const label = ev.label ?? null;
  const labelPn = label?.fields.partNumber?.trim() || '';
  if (!pn && (l.category === 'SSD' || l.category === 'HDD')) {
    out.push({
      lineId: l.id, severity: labelPn ? 'warn' : 'info', code: 'pn_missing', field: 'partNumber',
      currentValue: null, suggestedValue: labelPn || null,
      message: `${lineNo(l)} has no part number`, confidence: labelPn ? 0.6 : null,
      sources: labelPn ? [labelSource(label!, labelPn)] : [],
    });
  } else if (pn && labelPn && canonicalPartNumber(labelPn) !== canonicalPartNumber(pn)) {
    out.push({
      lineId: l.id, severity: 'warn', code: 'pn_label_differs', field: 'partNumber',
      currentValue: pn, suggestedValue: labelPn,
      message: `${lineNo(l)} part number is ${pn}; its label reads ${labelPn}`,
      confidence: 0.5, sources: [labelSource(label!, labelPn)],
    });
  }
  for (const f of DRIVE_FIELDS) {
    const s = storedOf(l, f);
    const lv = label?.fields[f]?.trim() || '';
    const w = ev.web?.specs[f]?.trim() || '';
    // Two witnesses agreeing outrank one; a lone witness is a warning.
    const agreed = lv && w && flat(lv) === flat(w) ? lv : '';
    const v = agreed || lv || w;
    if (!v) continue;
    const sources: FindingSource[] = [
      ...(lv ? [labelSource(label!, lv)] : []),
      ...(w ? [{ kind: 'web' as const, urls: ev.web!.sourceUrls, value: w }] : []),
    ];
    if (!s) {
      out.push({
        lineId: l.id, severity: 'info', code: 'spec_blank', field: f, currentValue: null, suggestedValue: v,
        message: `${lineNo(l)} ${f} is blank; ${lv ? 'the label' : 'the web'} says ${v}`,
        confidence: agreed ? 0.8 : 0.5, sources,
      });
    } else if (flat(v) !== flat(s) && !(lv && w && !agreed && (flat(lv) === flat(s) || flat(w) === flat(s)))) {
      out.push(mismatch(l, f, s, v, agreed ? 'error' : 'warn', agreed ? 0.85 : 0.5, sources,
        `${lv ? 'the label' : 'the web'} says ${v}`));
    }
  }
  return out;
}

function labelSource(label: LabelRead, value: string): FindingSource {
  return { kind: 'label', read: label.read, url: label.url, value };
}

function mismatch(
  l: ReviewLine, f: string, current: string, suggested: string,
  severity: Finding['severity'], confidence: number, sources: FindingSource[], why: string,
): Finding {
  return {
    lineId: l.id, severity, code: 'spec_mismatch', field: f,
    currentValue: current, suggestedValue: suggested,
    message: `${lineNo(l)} ${f} is ${current}; ${why}`,
    confidence, sources,
  };
}

/**
 * Whether a finding still describes the line: the field holds what it held
 * when the review read it. A finding that no longer does is stale, and
 * applying it would overwrite an edit made since.
 */
export function findingIsCurrent(
  f: { field: string | null; currentValue: string | null },
  line: Record<string, unknown> | undefined,
): boolean {
  if (!line) return false;
  if (!f.field) return true;
  return flat(line[f.field]) === flat(f.currentValue);
}
