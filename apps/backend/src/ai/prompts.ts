// src/ai/prompts.ts
import type { LineCategory } from '../types';

// Every prompt asks the model to emit `_confidence` (0..1) alongside the
// extracted fields — that is the value the UI surfaces and gates autofill on.
// Without an explicit instruction the field was effectively a fiction:
// previously the backend stamped 0.85 on every result regardless of how the
// model actually read the label.
const CONFIDENCE_INSTRUCTION =
  '_CONFIDENCE — also emit "_confidence": a number 0..1 representing how sure you are the extracted values match the label. Be honest: emit 0.95+ only when every field above is unambiguous; emit 0.5 or below when the image is blurry, glare-obscured, partially out-of-frame, or you had to guess any field.';

export const PROMPT_BY_CATEGORY: Record<LineCategory, string> = {
  RAM: `You are reading a server/desktop/laptop RAM module label. Respond with a single minified JSON object and nothing else — no markdown, no code fences, no prose:
{"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"4GB|8GB|16GB|32GB|64GB|128GB","generation":"DDR2|DDR3|DDR4|DDR5","type":"Desktop|Server|Laptop","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx16|1Rx8|1Rx4|2Rx16|2Rx8|2Rx4|4Rx8|4Rx4|8Rx4","speed":"MT/s number only","partNumber":"…","_confidence":0.0}
CAPACITY — number immediately followed by "GB", NO space and no other text. Write "32GB", never "32 GB".
GENERATION and TYPE are SEPARATE fields — never put a DDR value in "type".
  generation = the DDR family. Use the "PC" code printed on the label, never infer from speed alone:
    PC2-… = DDR2, PC3-…/PC3L-… = DDR3, PC4-… = DDR4, PC5-… = DDR5.
  type = the machine the module goes in: Desktop, Server, or Laptop.
CLASSIFICATION — the module form factor: SODIMM, UDIMM, RDIMM, or LRDIMM.
TYPE — derive from the form factor: SODIMM = Laptop, UDIMM = Desktop, RDIMM/LRDIMM/ECC = Server. Always emit BOTH generation and type when the form factor is readable.
SPEED — digits only, no "MHz"/"MT/s" suffix.
PARTNUMBER — the part number value only; drop any "PN:" / "P/N" / "S/N" label.
${CONFIDENCE_INSTRUCTION}
Only include a field if you can read or derive it confidently. Omit any field you are unsure about — do NOT guess.`,
  SSD: `You are reading an enterprise SSD label. Respond as compact JSON only:
{"brand":"…","capacity":"number+GB or TB, NO space e.g. 960GB or 1.92TB","interface":"SATA|SAS|NVMe|U.2","formFactor":"2.5\\"|M.2 2280|M.2 22110|U.2|AIC","partNumber":"value only, drop PN:/S/N labels","_confidence":0.0}
${CONFIDENCE_INSTRUCTION}
Omit unknown fields. No prose.`,
  HDD: `You are reading an enterprise HDD label. Respond as compact JSON only:
{"brand":"…","capacity":"number+TB, NO space e.g. 4TB","interface":"SATA|SAS","formFactor":"2.5\\"|3.5\\"","rpm":"digits only: 5400|7200|10000|15000","partNumber":"value only, drop PN:/S/N labels","_confidence":0.0}
${CONFIDENCE_INSTRUCTION}
Omit unknown fields. No prose.`,
  Other: `You are reading a server-component label (CPU, NIC, PSU, GPU, etc). Respond as compact JSON only:
{"description":"human-readable name","partNumber":"…","_confidence":0.0}
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
