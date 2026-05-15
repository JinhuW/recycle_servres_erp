// src/ai/prompts.ts
import type { LineCategory } from '../types';

export const PROMPT_BY_CATEGORY: Record<LineCategory, string> = {
  RAM: `You are reading a server RAM module label. Extract these fields and respond as compact JSON only:
{"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"… GB","type":"DDR3|DDR4|DDR5","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx16|1Rx8|1Rx4|2Rx16|2Rx8|2Rx4|4Rx8|4Rx4|8Rx4","speed":"MT/s number only","partNumber":"…"}
TYPE — use the "PC" code printed on the label, never infer the type from speed alone:
  PC2-… = DDR2, PC3-…/PC3L-… = DDR3, PC4-… = DDR4, PC5-… = DDR5.
CLASSIFICATION — from the module form factor: SODIMM = laptop, UDIMM = desktop, RDIMM/LRDIMM/ECC = server.
Only include a field if you can read it clearly on the label. Omit any field you are unsure about — do NOT guess. No prose.`,
  SSD: `You are reading an enterprise SSD label. Respond as compact JSON only:
{"brand":"…","capacity":"… GB or TB","interface":"SATA|SAS|NVMe|U.2","formFactor":"2.5\\"|M.2 2280|M.2 22110|U.2|AIC","partNumber":"…"}
Omit unknown fields. No prose.`,
  HDD: `You are reading an enterprise HDD label. Respond as compact JSON only:
{"brand":"…","capacity":"… TB","interface":"SATA|SAS","formFactor":"2.5\\"|3.5\\"","rpm":"5400|7200|10000|15000","partNumber":"…"}
Omit unknown fields. No prose.`,
  Other: `You are reading a server-component label (CPU, NIC, PSU, GPU, etc). Respond as compact JSON only:
{"description":"human-readable name","partNumber":"…"}
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
