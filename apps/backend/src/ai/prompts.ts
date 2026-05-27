// src/ai/prompts.ts
import type { LineCategory } from '../types';

// Every prompt asks the model to emit `_confidence` (0..1) alongside the
// extracted fields — that is the value the UI surfaces.
// The rubric is tiered with explicit mid-range anchors. The earlier version
// only anchored 0.95+ and ≤0.5, which pushed the model to a bimodal
// distribution (perfect or "guessing"); a single slightly-inferred field on
// an otherwise clean scan would land below the 0.5 anchor and trip the UI's
// "please verify every field" warning. The middle bands give the model
// somewhere honest to land for "good scan with one ambiguity".
const CONFIDENCE_INSTRUCTION =
  '_CONFIDENCE — emit "_confidence": a number 0..1 reflecting how cleanly the label could be read. Use these anchors:\n' +
  '  0.9-1.0: every emitted field read unambiguously; sticker fully in-frame and crisp.\n' +
  '  0.7-0.9: every emitted field read clearly; some values derived from standard conventions (form-factor→type, PC-code→generation).\n' +
  '  0.5-0.7: most fields read cleanly; one field slightly ambiguous (partial glare, small focus drift, ink wear) but still legible.\n' +
  '  0.3-0.5: multiple fields visually ambiguous; label angled, partially out of frame, or noticeably blurry.\n' +
  '  <0.3: image is largely illegible — most fields unreadable.\n' +
  'Use the full 0..1 range honestly. Most clean shots should land at 0.75-0.9, not 0.95+. Omit any field you cannot read; do NOT guess.';

// Fields each category's JSON schema asks for (excluding the _confidence
// sentinel). The OCR layer uses the count to derive a coverage-based floor
// on confidence — the prompt tells the model to omit unsure fields, so a
// high field count is itself evidence the label was readable. The full
// field list also drives the partial-fill warning logged from scan.ts: any
// expected field missing after normalization is the "AI couldn't fill the
// form" signal we surface to errors.jsonl.
export const EXPECTED_FIELDS_BY_CATEGORY: Record<LineCategory, readonly string[]> = {
  RAM: ['brand', 'capacity', 'generation', 'type', 'classification', 'rank', 'speed', 'partNumber'],
  SSD: ['brand', 'capacity', 'interface', 'formFactor', 'partNumber'],
  HDD: ['brand', 'capacity', 'interface', 'formFactor', 'rpm', 'partNumber'],
  Other: ['description', 'partNumber'],
};

export const EXPECTED_FIELD_COUNT: Record<LineCategory, number> = {
  RAM: EXPECTED_FIELDS_BY_CATEGORY.RAM.length,
  SSD: EXPECTED_FIELDS_BY_CATEGORY.SSD.length,
  HDD: EXPECTED_FIELDS_BY_CATEGORY.HDD.length,
  Other: EXPECTED_FIELDS_BY_CATEGORY.Other.length,
};

export const PROMPT_BY_CATEGORY: Record<LineCategory, string> = {
  RAM: `You are reading a server/desktop/laptop RAM module label. Respond with a single minified JSON object and nothing else — no markdown, no code fences, no prose:
{"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"4GB|8GB|16GB|32GB|64GB|128GB","generation":"DDR2|DDR3|DDR4|DDR5","type":"Desktop|Server|Laptop","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx4|1Rx8|1Rx16|1Rx32|2Rx4|2Rx8|2Rx16|2Rx32|4Rx4|4Rx8|4Rx16|8Rx4|8Rx8","speed":"MT/s number only","partNumber":"…","_confidence":0.0}
CAPACITY — number immediately followed by "GB", NO space and no other text. Write "32GB", never "32 GB".
GENERATION and TYPE are SEPARATE fields — never put a DDR value in "type".
  generation = the DDR family. Use the "PC" code printed on the label, never infer from speed alone:
    PC2-… = DDR2, PC3-…/PC3L-… = DDR3, PC4-… = DDR4, PC5-… = DDR5.
  type = the machine the module goes in: Desktop, Server, or Laptop.
CLASSIFICATION — the module form factor: SODIMM, UDIMM, RDIMM, or LRDIMM.
TYPE — derive from the form factor: SODIMM = Laptop, UDIMM = Desktop, RDIMM/LRDIMM/ECC = Server. Always emit BOTH generation and type when the form factor is readable.
SPEED — emit the digits printed on the label, no conversion. The label gives you the speed in one of these forms; copy the number verbatim, do NOT divide, multiply, or interpret:
  - "NNNN MT/s" or "NNNN MHz" → NNNN.
  - "DDRx-NNNN…" → the digits after the dash (ignore any trailing letters).
  - "PCx-NNNN…" or "PCx-NNNNN…" → the digits after the dash, ignoring any trailing letters/codes. Both 4-digit ("PC4-3200AA-UC0-12" → 3200) and 5-digit ("PC3-12800" → 12800, "PC4-25600" → 25600) forms are emitted as-printed — the label is the source of truth, do not translate between them.
Every DDR module label carries one of these notations. If you can read brand and part number, you can read this. Omit speed only when no such notation is visible.
PARTNUMBER — emit only the CORE part number. Drop any "PN:" / "P/N" / "S/N" label prefix, drop everything from the first hyphen onward (speed-grade / rev suffix), and drop any trailing tokens (date codes, lot markers like "NO AD", country codes). Examples:
  - "HMAA1GU6CJR6N-XN NO AD" → "HMAA1GU6CJR6N"
  - "M471A1K43DB1-CTD" → "M471A1K43DB1"
  - "HMT84GL7AMR4C-RD MC AD 1420" → "HMT84GL7AMR4C"
  - "M393A4K40DB3-CWE" → "M393A4K40DB3"
  - "KCP318SD8/16" (no hyphen) → "KCP318SD8/16"
${CONFIDENCE_INSTRUCTION}
Only include a field if you can read or derive it confidently. Omit any field you are unsure about — do NOT guess.`,
  SSD: `You are reading an enterprise SSD label. Respond as compact JSON only:
{"brand":"…","capacity":"number+GB or TB, NO space e.g. 960GB or 1.92TB","interface":"SATA|SAS|NVMe|U.2","formFactor":"2.5\\"|M.2 2280|M.2 22110|U.2|AIC","partNumber":"CORE only: drop PN:/S/N label, drop everything after first hyphen, drop trailing date/lot tokens (MZ7LH960HAJR-00005 → MZ7LH960HAJR)","_confidence":0.0}
${CONFIDENCE_INSTRUCTION}
Omit unknown fields. No prose.`,
  HDD: `You are reading an enterprise HDD label. Respond as compact JSON only:
{"brand":"…","capacity":"number+TB, NO space e.g. 4TB","interface":"SATA|SAS","formFactor":"2.5\\"|3.5\\"","rpm":"digits only: 5400|7200|10000|15000","partNumber":"CORE only: drop PN:/S/N label, drop everything after first hyphen, drop trailing date/lot tokens (ST4000NM0023-1MA107 → ST4000NM0023)","_confidence":0.0}
${CONFIDENCE_INSTRUCTION}
Omit unknown fields. No prose.`,
  Other: `You are reading a server-component label (CPU, NIC, PSU, GPU, etc). Respond as compact JSON only:
{"description":"human-readable name","partNumber":"CORE only: drop everything after first hyphen and any trailing date/lot tokens","_confidence":0.0}
${CONFIDENCE_INSTRUCTION}
No prose.`,
};

// Models sometimes wrap JSON in ``` fences or add stray prose. Strip fences,
// try a direct parse, then fall back to the first {…} block.
export function parseModelJson(text: string): Record<string, unknown> | null {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
